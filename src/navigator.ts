import * as ts from 'typescript';
import * as vscode from 'vscode';

/** One "step": a statement the user can stop on. Lines are 1-based. */
export interface Step {
  line: number;
  endLine: number;
  text: string;
  /** Project calls made by this statement, with the callee identifier position. */
  calls: { name: string; position: vscode.Position }[];
  /** Variables this statement declares (incl. destructuring), for example values. */
  declared: { name: string; position: vscode.Position }[];
}

/** A function the user is stepping through. */
export interface Frame {
  uri: vscode.Uri;
  name: string;
  /** Signature + body, as shown to the model. */
  source: string;
  startLine: number;
  steps: Step[];
  index: number;
  /** Why we stepped into this frame (empty for the entry frame). */
  reason: string;
}

type FnNode = ts.FunctionLikeDeclaration;

function parse(doc: vscode.TextDocument): ts.SourceFile {
  const kind = doc.languageId === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(doc.fileName, doc.getText(), ts.ScriptTarget.Latest, true, kind);
}

function fnName(fn: FnNode): string {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return '(anonymous)';
}

function isFnWithBody(n: ts.Node): n is FnNode {
  return (
    (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)) &&
    n.body !== undefined
  );
}

/** Innermost function-like node whose body contains `offset`. */
function enclosingFunction(sf: ts.SourceFile, offset: number): FnNode | undefined {
  let found: FnNode | undefined;
  const visit = (n: ts.Node) => {
    if (offset < n.getStart() || offset > n.getEnd()) return;
    if (isFnWithBody(n)) found = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** Statements in document order, descending into blocks but never into nested functions. */
function collectSteps(sf: ts.SourceFile, body: ts.Node, doc: vscode.TextDocument): Step[] {
  const steps: Step[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isStatement(n) && !ts.isBlock(n)) {
      // The step covers the statement head only: `if (…)`, `for (…)`, `try`, not their bodies —
      // unless the whole statement fits on one line, then it is a single step.
      const head = headNode(n, doc);
      const start = doc.positionAt(head.getStart());
      const end = doc.positionAt(head.getEnd());
      steps.push({
        line: start.line + 1,
        endLine: end.line + 1,
        text: head.getText(),
        calls: collectCalls(head, doc),
        declared: collectDeclared(n, doc),
      });
      if (head === n) return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return steps;
}

function headNode(s: ts.Statement, doc: vscode.TextDocument): ts.Node {
  const oneLine = doc.positionAt(s.getStart()).line === doc.positionAt(s.getEnd()).line;
  if (oneLine) return s;
  if (ts.isIfStatement(s) || ts.isWhileStatement(s) || ts.isSwitchStatement(s)) return s.expression;
  if (ts.isForStatement(s)) return s.condition ?? s;
  if (ts.isForOfStatement(s) || ts.isForInStatement(s)) return s.expression;
  return s;
}

function collectCalls(n: ts.Node, doc: vscode.TextDocument) {
  const calls: Step['calls'] = [];
  const visit = (c: ts.Node) => {
    if (ts.isFunctionLike(c)) return;
    if (ts.isCallExpression(c) || ts.isNewExpression(c)) {
      const callee = c.expression;
      const id = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
      if (ts.isIdentifier(id)) {
        calls.push({ name: callee.getText(), position: doc.positionAt(id.getStart()) });
      }
    }
    ts.forEachChild(c, visit);
  };
  visit(n);
  return calls;
}

/** Names bound by `const/let/var` in this statement, including destructuring patterns. */
function collectDeclared(s: ts.Statement, doc: vscode.TextDocument): Step['declared'] {
  const out: Step['declared'] = [];
  if (!ts.isVariableStatement(s)) return out;
  const visitName = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) out.push({ name: name.text, position: doc.positionAt(name.getStart()) });
    else for (const el of name.elements) if (ts.isBindingElement(el)) visitName(el.name);
  };
  for (const d of s.declarationList.declarations) visitName(d.name);
  return out;
}

/** Build the frame for the function containing `line` (1-based); `undefined` if none. */
export function frameAt(doc: vscode.TextDocument, line: number, reason = ''): Frame | undefined {
  const sf = parse(doc);
  const offset = doc.offsetAt(new vscode.Position(line - 1, 0).translate(0, doc.lineAt(line - 1).firstNonWhitespaceCharacterIndex));
  const fn = enclosingFunction(sf, offset);
  if (!fn || !fn.body) return undefined;
  const steps = collectSteps(sf, fn.body, doc);
  if (steps.length === 0) return undefined;
  let index = steps.findIndex((s) => s.line >= line);
  if (index < 0) index = 0;
  return {
    uri: doc.uri,
    name: fnName(fn),
    source: fn.getText(),
    startLine: doc.positionAt(fn.getStart()).line + 1,
    steps,
    index,
    reason,
  };
}

/** Resolve a call to a definition inside the workspace (never node_modules). */
export async function resolveProjectCallee(
  uri: vscode.Uri,
  call: Step['calls'][number],
): Promise<vscode.Location | undefined> {
  const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider',
    uri,
    call.position,
  );
  for (const d of defs ?? []) {
    const loc = 'targetUri' in d ? new vscode.Location(d.targetUri, d.targetSelectionRange ?? d.targetRange) : d;
    const inWorkspace = vscode.workspace.getWorkspaceFolder(loc.uri) !== undefined;
    if (inWorkspace && !loc.uri.fsPath.includes('node_modules') && !loc.uri.fsPath.endsWith('.d.ts')) return loc;
  }
  return undefined;
}

/** Hover text for a position, flattened to one line. */
export async function hoverText(uri: vscode.Uri, position: vscode.Position): Promise<string | undefined> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position);
  const parts = (hovers ?? []).flatMap((h) =>
    h.contents.map((c) => (typeof c === 'string' ? c : c.value)),
  );
  const text = parts.join(' ').replace(/```\w*/g, '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : undefined;
}

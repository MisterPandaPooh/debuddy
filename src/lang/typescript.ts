import * as ts from 'typescript';
import * as vscode from 'vscode';
import { Frame, LanguageSupport, Step } from './types';

type FnNode = ts.FunctionLikeDeclaration;

function parse(doc: vscode.TextDocument): ts.SourceFile {
  const kind = { typescript: ts.ScriptKind.TS, typescriptreact: ts.ScriptKind.TSX, javascriptreact: ts.ScriptKind.JSX }[doc.languageId] ?? ts.ScriptKind.JS;
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
  const lineOf = (pos: number) => doc.positionAt(pos).line + 1;
  // Keyword-only steps (`try`, `catch (e)`, `finally`) make no calls; their blocks are walked separately.
  // Innermost enclosing `catch` while walking a try block, so steps know where a throw lands.
  const handlers: { line: number; text: string }[] = [];
  const push = (start: number, end: number, text: string) =>
    steps.push({ line: lineOf(start), endLine: lineOf(end), text, calls: [], declared: [], handler: handlers.at(-1) });
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isTryStatement(n)) {
      // `try` / `catch (e)` / `finally` each get a step; their blocks are walked normally.
      const catchText = n.catchClause
        ? n.catchClause.getText().slice(0, n.catchClause.block.getStart() - n.catchClause.getStart()).trim()
        : undefined;
      push(n.getStart(), n.tryBlock.getStart(), 'try');
      if (n.catchClause && catchText) handlers.push({ line: lineOf(n.catchClause.getStart()), text: catchText });
      ts.forEachChild(n.tryBlock, visit);
      if (n.catchClause && catchText) {
        handlers.pop();
        push(n.catchClause.getStart(), n.catchClause.block.getStart(), catchText);
        ts.forEachChild(n.catchClause.block, visit);
      }
      if (n.finallyBlock) {
        push(n.finallyBlock.getStart() - 'finally '.length, n.finallyBlock.getStart(), 'finally');
        ts.forEachChild(n.finallyBlock, visit);
      }
      return;
    }
    if (ts.isStatement(n) && !ts.isBlock(n)) {
      // The step covers the statement head only: `if (…)`, `for (…)`, `try`, not their bodies —
      // unless the whole statement fits on one line, then it is a single step.
      const head = headNode(n, doc);
      const start = doc.positionAt(head.getStart());
      const end = doc.positionAt(head.getEnd());
      // `} else if (…) {` shares a line with the end of `then`: that line belongs to the else side.
      const elseLine = ts.isIfStatement(n) && n.elseStatement ? lineOf(n.elseStatement.getStart()) : undefined;
      const thenTo = ts.isIfStatement(n) ? lineOf(n.thenStatement.getEnd()) : 0;
      // Only a real fork (an else) is worth a question; a lone `if` is read in order.
      const branches =
        ts.isIfStatement(n) && head !== n && n.elseStatement
          ? [
              { label: 'then', from: lineOf(n.thenStatement.getStart()), to: elseLine !== undefined && elseLine <= thenTo ? elseLine - 1 : thenTo },
              ...(n.elseStatement && elseLine !== undefined
                ? [{ label: 'else', from: elseLine, to: lineOf(n.elseStatement.getEnd()) }]
                : []),
            ]
          : undefined;
      steps.push({
        line: start.line + 1,
        endLine: end.line + 1,
        text: head.getText(),
        calls: collectCalls(head, doc),
        declared: collectDeclared(n, doc),
        branches,
        handler: handlers.at(-1),
        guard: ts.isIfStatement(n) ? guardKind(n.thenStatement) : undefined,
        body: head !== n ? bodyRange(n, doc) : undefined,
        throwsSelf: ts.isThrowStatement(n) ? thrownName(n) : undefined,
        mayThrow: head === n && !ts.isThrowStatement(n) ? nestedThrow(n) : undefined,
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

function thrownName(n: ts.ThrowStatement): string {
  const e = n.expression;
  const id = ts.isNewExpression(e) || ts.isCallExpression(e) ? e.expression : e;
  return ts.isIdentifier(id) ? id.text : ts.isPropertyAccessExpression(id) ? id.name.text : 'error';
}

/** The block a lone `if` or a loop owns, as a line range; `undefined` when the statement forks (if/else). */
function bodyRange(s: ts.Statement, doc: vscode.TextDocument): { from: number; to: number } | undefined {
  const body = ts.isIfStatement(s) && !s.elseStatement ? s.thenStatement
    : ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isWhileStatement(s) || ts.isDoStatement(s) ? s.statement
    : undefined;
  if (!body) return undefined;
  return { from: doc.positionAt(body.getStart()).line + 1, to: doc.positionAt(body.getEnd()).line + 1 };
}

/** How an `if` body leaves the function, when it does: `return`, `throw`, `continue`, `break`. */
function guardKind(body: ts.Statement): string | undefined {
  const last = ts.isBlock(body) ? body.statements.at(-1) : body;
  if (!last) return undefined;
  if (ts.isReturnStatement(last)) return 'return';
  if (ts.isThrowStatement(last)) return 'throw';
  if (ts.isContinueStatement(last)) return 'continue';
  if (ts.isBreakStatement(last)) return 'break';
  return undefined;
}

/** First `throw` nested in a statement (e.g. a one-line `if`), excluding nested functions. */
function nestedThrow(n: ts.Node): string | undefined {
  let found: string | undefined;
  const visit = (c: ts.Node) => {
    if (found || ts.isFunctionLike(c)) return;
    if (ts.isThrowStatement(c)) found = thrownName(c);
    else ts.forEachChild(c, visit);
  };
  ts.forEachChild(n, visit);
  return found;
}

/** `throw new X()` / `throw X` sites in a function body, excluding nested functions. */
function collectThrows(body: ts.Node): string[] {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isThrowStatement(n)) out.add(thrownName(n));
    ts.forEachChild(n, visit);
  };
  visit(body);
  return [...out];
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
function frameAt(doc: vscode.TextDocument, line: number, reason = ''): Frame | undefined {
  const sf = parse(doc);
  const offset = doc.offsetAt(new vscode.Position(line - 1, 0).translate(0, doc.lineAt(line - 1).firstNonWhitespaceCharacterIndex));
  const fn = enclosingFunction(sf, offset);
  if (!fn || !fn.body) return undefined;
  const steps = collectSteps(sf, fn.body, doc);
  if (steps.length === 0) return undefined;
  let index = steps.findIndex((s) => s.line >= line);
  if (index < 0) index = 0;
  const nameNode = fn.name ?? (ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined);
  return {
    uri: doc.uri,
    name: fnName(fn),
    source: fn.getText(),
    startLine: doc.positionAt(fn.getStart()).line + 1,
    steps,
    index,
    reason,
    throws: collectThrows(fn.body),
    skip: [],
    namePosition: nameNode && ts.isIdentifier(nameNode) ? doc.positionAt(nameNode.getStart()) : undefined,
  };
}

/** A function declared or assigned under `name` anywhere in the file (no server needed). */
function findFunction(doc: vscode.TextDocument, name: string): vscode.Location | undefined {
  const want = name.split('.').pop();
  const sf = parse(doc);
  let found: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (isFnWithBody(n) && fnName(n) === want) {
      found = n.name ?? (ts.isVariableDeclaration(n.parent) ? n.parent.name : ts.isPropertyAssignment(n.parent) ? n.parent.name : n);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) return undefined;
  return new vscode.Location(doc.uri, new vscode.Range(doc.positionAt(found.getStart()), doc.positionAt(found.getEnd())));
}

export const typescriptLanguage: LanguageSupport = {
  languages: ['typescript', 'javascript', 'typescriptreact', 'javascriptreact'],
  frameAt,
  findFunction,
};

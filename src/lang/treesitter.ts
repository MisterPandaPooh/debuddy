import * as path from 'path';
import * as vscode from 'vscode';
import type { Language, Node, Parser as ParserType } from 'web-tree-sitter';
import { Branch, CallSite, Frame, LanguageSupport, Step } from './types';

/**
 * What a tree-sitter grammar needs to tell the generic walker. Node type names come straight
 * from the grammar (`node-types.json`); field names from `childForFieldName`.
 */
export interface TreeSitterProfile {
  languages: string[];
  /** Grammar file name under dist/grammars. */
  grammar: string;
  /** Function-like node types: the walk starts at the innermost one containing the cursor. */
  functionTypes: string[];
  /** Function-like nodes that are never descended into (nested functions, lambdas, closures). */
  nestedTypes: string[];
  /** Node types whose named children are statements. */
  blockTypes: string[];
  /** Expression-statement wrappers to unwrap (rust `expression_statement`). */
  unwrapTypes: string[];
  /** Statements that own blocks: how to make a head step and where the branches are. */
  compound: Record<string, CompoundSpec>;
  /** Call node type → field holding the callee. */
  callTypes: Record<string, string>;
  /** Declaration node type → field holding the bound pattern/name. */
  declTypes: Record<string, string>;
  /** Node types that raise, and how to name what they raise. */
  throwTypes: Record<string, (n: Node) => string | undefined>;
  /** Nodes that *may* raise without being a raise statement themselves (rust `?`). */
  mayThrowTypes?: Record<string, (n: Node) => string | undefined>;
  /** try/except shape, when the language has one. */
  tryType?: { type: string; body: string; handler: string; finally?: string; else?: string };
}

export interface CompoundSpec {
  /** Field holding the head expression (condition / value); the head step text. Omit = keyword only. */
  head?: string;
  /** Fields or child node types holding the bodies to descend into, in order. */
  bodies: string[];
  /** Child node types that are alternative clauses (elif/else/match arms): each becomes a step + body. */
  clauses?: string[];
  /** Label for branch picking: `then` for the first body, clause text for the others. */
  branching?: boolean;
}

let parserPromise: Promise<typeof import('web-tree-sitter')> | undefined;
let grammarDir = '';
const languages = new Map<string, Promise<Language>>();

/** Where the .wasm files live (set from the extension path at activation). */
export function setGrammarDir(dir: string) {
  grammarDir = dir;
}

async function runtime() {
  parserPromise ??= (async () => {
    const ts = (await import('web-tree-sitter')) as typeof import('web-tree-sitter');
    await ts.Parser.init({ locateFile: (f: string) => path.join(grammarDir, f) });
    return ts;
  })();
  return parserPromise;
}

async function grammar(file: string): Promise<Language> {
  let p = languages.get(file);
  if (!p) {
    p = runtime().then((ts) => ts.Language.load(path.join(grammarDir, file)));
    languages.set(file, p);
  }
  return p;
}

export function treeSitterLanguage(profile: TreeSitterProfile): LanguageSupport {
  return {
    languages: profile.languages,
    async frameAt(doc, line, reason = '') {
      const ts = await runtime();
      const lang = await grammar(profile.grammar);
      const parser: ParserType = new ts.Parser();
      parser.setLanguage(lang);
      const tree = parser.parse(doc.getText());
      try {
        if (!tree) return undefined;
        return buildFrame(profile, tree.rootNode, doc, line, reason);
      } finally {
        tree?.delete();
        parser.delete();
      }
    },
    async findFunction(doc, name) {
      const ts = await runtime();
      const lang = await grammar(profile.grammar);
      const parser: ParserType = new ts.Parser();
      parser.setLanguage(lang);
      const tree = parser.parse(doc.getText());
      try {
        if (!tree) return undefined;
        const want = name.split(/\.|::/).pop();
        let found: Node | undefined;
        const visit = (n: Node) => {
          if (found) return;
          if (profile.functionTypes.includes(n.type) && n.childForFieldName('name')?.text === want) found = n;
          else for (const c of n.namedChildren) visit(c);
        };
        visit(tree.rootNode);
        if (!found) return undefined;
        const id = found.childForFieldName('name')!;
        return new vscode.Location(doc.uri, new vscode.Range(doc.positionAt(id.startIndex), doc.positionAt(id.endIndex)));
      } finally {
        tree?.delete();
        parser.delete();
      }
    },
  };
}

function buildFrame(p: TreeSitterProfile, root: Node, doc: vscode.TextDocument, line: number, reason: string): Frame | undefined {
  const offset = doc.offsetAt(new vscode.Position(line - 1, doc.lineAt(line - 1).firstNonWhitespaceCharacterIndex));
  let fn: Node | undefined;
  const find = (n: Node) => {
    if (n.startIndex > offset || n.endIndex < offset) return;
    if (p.functionTypes.includes(n.type)) fn = n;
    for (const c of n.namedChildren) find(c);
  };
  find(root);
  if (!fn) return undefined;
  const body = fn.childForFieldName('body');
  if (!body) return undefined;
  const steps = collectSteps(p, body, doc);
  if (steps.length === 0) return undefined;
  let index = steps.findIndex((s) => s.line >= line);
  if (index < 0) index = 0;
  const nameNode = fn.childForFieldName('name');
  return {
    uri: doc.uri,
    name: nameNode?.text ?? '(anonymous)',
    source: fn.text,
    startLine: fn.startPosition.row + 1,
    steps,
    index,
    reason,
    throws: collectThrows(p, body),
    namePosition: nameNode ? doc.positionAt(nameNode.startIndex) : undefined,
    skip: [],
  };
}

const lineOf = (n: Node) => n.startPosition.row + 1;
const endLineOf = (n: Node) => n.endPosition.row + 1;

function collectSteps(p: TreeSitterProfile, body: Node, doc: vscode.TextDocument): Step[] {
  const steps: Step[] = [];
  const handlers: { line: number; text: string }[] = [];

  const push = (line: number, endLine: number, text: string, scan: Node[], extra: Partial<Step> = {}): Step => {
    const step: Step = {
      line,
      endLine,
      text,
      calls: scan.flatMap((n) => collectCalls(p, n, doc)),
      declared: scan.flatMap((n) => collectDeclared(p, n, doc)),
      handler: handlers.at(-1),
      ...extra,
    };
    for (const n of scan) {
      step.throwsSelf ??= throwName(p, n, p.throwTypes);
      step.mayThrow ??= p.mayThrowTypes ? throwName(p, n, p.mayThrowTypes) : undefined;
    }
    steps.push(step);
    return step;
  };

  /** Head of a compound statement: its text up to the first body, minus the trailing `:` / `{`. */
  const headText = (n: Node, firstBody: Node | undefined) => {
    const end = firstBody ? firstBody.startIndex : n.endIndex;
    return doc.getText(new vscode.Range(doc.positionAt(n.startIndex), doc.positionAt(end))).replace(/[\s:{]+$/, '').trim();
  };

  const visitBlock = (block: Node) => {
    for (const child of block.namedChildren) visitStatement(child);
  };

  const visitStatement = (node: Node) => {
    let n = node;
    if (p.unwrapTypes.includes(n.type) && n.namedChildCount === 1) n = n.namedChildren[0];
    if (p.nestedTypes.includes(n.type)) return;
    if (n.type === 'comment') return;

    if (p.tryType && n.type === p.tryType.type) {
      const tryBody = n.childForFieldName(p.tryType.body) ?? n.namedChildren.find((c) => p.blockTypes.includes(c.type));
      const clauses = n.namedChildren.filter((c) => c.type === p.tryType!.handler);
      const fin = p.tryType.finally ? n.namedChildren.find((c) => c.type === p.tryType!.finally) : undefined;
      push(lineOf(n), lineOf(n), 'try', []);
      const first = clauses[0];
      if (first) handlers.push({ line: lineOf(first), text: headText(first, first.namedChildren.find((c) => p.blockTypes.includes(c.type))) });
      if (tryBody) visitBlock(tryBody);
      if (first) handlers.pop();
      for (const c of clauses) {
        const cb = c.namedChildren.find((x) => p.blockTypes.includes(x.type));
        push(lineOf(c), lineOf(c), headText(c, cb), c.namedChildren.filter((x) => !p.blockTypes.includes(x.type)));
        if (cb) visitBlock(cb);
      }
      const els = p.tryType.else ? n.namedChildren.find((c) => c.type === p.tryType!.else) : undefined;
      if (els) {
        const eb = els.namedChildren.find((x) => p.blockTypes.includes(x.type));
        push(lineOf(els), lineOf(els), 'else (no exception)', []);
        if (eb) visitBlock(eb);
      }
      if (fin) {
        const fb = fin.namedChildren.find((x) => p.blockTypes.includes(x.type));
        push(lineOf(fin), lineOf(fin), 'finally', []);
        if (fb) visitBlock(fb);
      }
      return;
    }

    const spec = p.compound[n.type];
    if (spec) {
      const bodies = spec.bodies.map((f) => n.childForFieldName(f) ?? n.namedChildren.find((c) => c.type === f)).filter((b): b is Node => !!b);
      const clauseHosts = [n, ...n.namedChildren.filter((c) => p.blockTypes.includes(c.type))];
      const clauses = spec.clauses ? clauseHosts.flatMap((h) => h.namedChildren.filter((c) => spec.clauses!.includes(c.type))) : [];
      const headNode = spec.head ? n.childForFieldName(spec.head) : undefined;
      const firstBody = bodies[0] ?? clauses[0];
      const text = headNode ? headNode.text : headText(n, firstBody);
      const branches: Branch[] | undefined = spec.branching
        ? [
            // the line where `then` ends and the next clause starts belongs to that clause
            ...bodies.map((b) => ({ label: 'then', from: lineOf(b), to: clauses[0] && lineOf(clauses[0]) <= endLineOf(b) ? lineOf(clauses[0]) - 1 : endLineOf(b) })),
            ...clauses.map((c) => ({ label: clauseLabel(headText(c, c.namedChildren.find((x) => p.blockTypes.includes(x.type)))) || c.type, from: lineOf(c), to: endLineOf(c) })),
          ]
        : undefined;
      const headStart = lineOf(n);
      const headEnd = headNode ? endLineOf(headNode) : headStart;
      push(headStart, headEnd, text, headNode ? [headNode] : [], { branches: branches && branches.length > 1 ? branches : undefined });
      for (const b of bodies) (p.blockTypes.includes(b.type) ? visitBlock : visitStatement)(b);
      for (const c of clauses) {
        const cb = c.namedChildren.find((x) => p.blockTypes.includes(x.type));
        const inner = c.namedChildren.filter((x) => !p.blockTypes.includes(x.type));
        // `else` on its own line is not worth a stop; `elif x` / `Err(e) =>` are.
        if (cb && inner.length === 0 && c.type.startsWith('else')) {
          visitBlock(cb);
          continue;
        }
        // `else if …`: the nested compound is the step, not the clause wrapping it.
        if (!cb && inner.some((x) => p.compound[x.type])) {
          for (const x of inner) visitStatement(x);
          continue;
        }
        push(lineOf(c), lineOf(c), headText(c, cb), inner);
        if (cb) visitBlock(cb);
        else if (inner.length) for (const x of inner) if (p.compound[x.type]) visitStatement(x);
      }
      return;
    }

    // A plain statement, possibly spanning lines.
    push(lineOf(n), endLineOf(n), n.text, [n]);
  };

  visitBlock(body);
  return steps;
}

/** `Err(e) => …` reads as `Err(e)`, `elif x > 1` stays; 30 chars max for the picker. */
function clauseLabel(head: string): string {
  const arrow = head.indexOf('=>');
  return (arrow > 0 ? head.slice(0, arrow) : head).trim().slice(0, 30);
}

function collectCalls(p: TreeSitterProfile, n: Node, doc: vscode.TextDocument): CallSite[] {
  const out: CallSite[] = [];
  const visit = (c: Node) => {
    if (p.nestedTypes.includes(c.type)) return;
    const field = p.callTypes[c.type];
    if (field) {
      const callee = c.childForFieldName(field);
      if (callee) {
        // Position on the last identifier of `a.b.c` so go-to-definition lands on the member.
        const ids = callee.descendantsOfType(['identifier', 'field_identifier', 'property_identifier', 'scoped_identifier']);
        const last = ids.filter((x): x is Node => !!x).at(-1) ?? callee;
        let name = callee.text.replace(/\s+/g, '');
        for (let prev = ''; prev !== name; ) (prev = name), (name = name.replace(/\([^()]*\)/g, ''));
        out.push({ name, position: doc.positionAt(last.startIndex) });
      }
    }
    for (const x of c.namedChildren) visit(x);
  };
  visit(n);
  return out;
}

function collectDeclared(p: TreeSitterProfile, n: Node, doc: vscode.TextDocument): Step['declared'] {
  const out: Step['declared'] = [];
  const visit = (c: Node) => {
    if (p.nestedTypes.includes(c.type)) return;
    const field = p.declTypes[c.type];
    if (field) {
      const target = c.childForFieldName(field);
      if (target && !/attribute|subscript|field_expression|index_expression|member/.test(target.type)) {
        const ids = target.type === 'identifier' ? [target] : target.descendantsOfType('identifier').filter((x): x is Node => !!x);
        for (const id of ids) out.push({ name: id.text, position: doc.positionAt(id.startIndex) });
      }
    }
    for (const x of c.namedChildren) visit(x);
  };
  visit(n);
  return out;
}

function throwName(p: TreeSitterProfile, n: Node, table: Record<string, (n: Node) => string | undefined>): string | undefined {
  let found: string | undefined;
  const visit = (c: Node) => {
    if (found || p.nestedTypes.includes(c.type)) return;
    const f = table[c.type];
    if (f) found = f(c);
    if (!found) for (const x of c.namedChildren) visit(x);
  };
  visit(n);
  return found;
}

function collectThrows(p: TreeSitterProfile, body: Node): string[] {
  const out = new Set<string>();
  const visit = (c: Node) => {
    if (p.nestedTypes.includes(c.type)) return;
    const f = p.throwTypes[c.type];
    const name = f?.(c);
    if (name) out.add(name);
    for (const x of c.namedChildren) visit(x);
  };
  visit(body);
  return [...out];
}

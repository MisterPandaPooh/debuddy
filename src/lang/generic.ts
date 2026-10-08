import * as vscode from 'vscode';
import { KeywordProfile, defaultKeywordProfile, keywordProfiles } from './keywords';
import { Branch, CallSite, Frame, LanguageSupport, Step } from './types';

/**
 * Any language with a language server: function boundaries from document symbols, statement
 * boundaries from selection ranges (VS Code's "Expand Selection"), the rest from small per-language
 * keyword tables. Less exact than a grammar, but it works wherever the user can already code.
 */
export const genericLanguage: LanguageSupport = {
  languages: ['*'],
  frameAt: genericFrameAt,
};

export function keywordProfileFor(languageId: string): KeywordProfile {
  return keywordProfiles.find((p) => p.languages.includes(languageId)) ?? defaultKeywordProfile;
}

const FUNCTION_KINDS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Constructor]);

async function genericFrameAt(doc: vscode.TextDocument, line: number, reason = ''): Promise<Frame | undefined> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri);
  const fn = innermostFunction(symbols ?? [], line - 1);
  if (!fn) return undefined;
  const profile = keywordProfileFor(doc.languageId);
  const startLine = fn.range.start.line + 1;
  const endLine = fn.range.end.line + 1;
  const steps = await collectSteps(doc, profile, startLine, endLine);
  if (steps.length === 0) return undefined;
  let index = steps.findIndex((s) => s.line >= line);
  if (index < 0) index = 0;
  const source = doc.getText(fn.range);
  return {
    uri: doc.uri,
    name: fn.name.replace(/\(.*$/, ''),
    source,
    startLine,
    steps,
    index,
    reason,
    throws: [...new Set(steps.flatMap((s) => (s.throwsSelf ? [s.throwsSelf] : [])))],
    namePosition: fn.selectionRange.start,
    skip: [],
  };
}

function innermostFunction(symbols: vscode.DocumentSymbol[], line0: number): vscode.DocumentSymbol | undefined {
  let found: vscode.DocumentSymbol | undefined;
  const visit = (s: vscode.DocumentSymbol) => {
    if (line0 < s.range.start.line || line0 > s.range.end.line) return;
    if (FUNCTION_KINDS.has(s.kind)) found = s;
    for (const c of s.children) visit(c);
  };
  for (const s of symbols) visit(s);
  return found;
}

/** Statement ranges: the largest selection range starting at the line that stays inside the function. */
async function statementRange(doc: vscode.TextDocument, pos: vscode.Position, endLine0: number): Promise<vscode.Range | undefined> {
  try {
    const [chain] = await vscode.commands.executeCommand<vscode.SelectionRange[]>('vscode.executeSelectionRangeProvider', doc.uri, [pos]);
    let best: vscode.Range | undefined;
    for (let r: vscode.SelectionRange | undefined = chain; r; r = r.parent) {
      if (!r.range.start.isEqual(pos)) break;
      if (r.range.end.line > endLine0) break;
      best = r.range;
    }
    return best;
  } catch {
    return undefined;
  }
}

async function collectSteps(doc: vscode.TextDocument, p: KeywordProfile, startLine: number, endLine: number): Promise<Step[]> {
  const steps: Step[] = [];
  const handlers: { line: number; text: string; indent: number }[] = [];
  let l = startLine + 1; // skip the signature line
  while (l <= endLine) {
    const tl = doc.lineAt(l - 1);
    const text = tl.text;
    const indent = tl.firstNonWhitespaceCharacterIndex;
    if (tl.isEmptyOrWhitespace || p.comment.test(text) || /^\s*[}\])]+\s*;?\s*$/.test(text)) {
      l++;
      continue;
    }
    // Leaving a try body (indentation back to the try line) drops its handler.
    while (handlers.length && (p.indentBased ? indent <= handlers.at(-1)!.indent : p.try?.handler.test(text))) handlers.pop();

    const pos = new vscode.Position(l - 1, indent);
    const range = await statementRange(doc, pos, endLine - 1);
    const isBranch = p.branch.find((b) => b.re.test(text));
    const isTry = p.try?.open.test(text);
    const isHandler = p.try?.handler.test(text);
    const isFinally = p.try?.finally?.test(text);
    const headOnly = isBranch || isTry || isHandler || isFinally || (range && range.end.line > l - 1 && /[:{]\s*$/.test(text));
    const stepEnd = headOnly || !range ? l : range.end.line + 1;
    const stepText = headOnly ? text.trim().replace(/[\s:{]+$/, '') : doc.getText(range!).trim();

    const step: Step = {
      line: l,
      endLine: stepEnd,
      text: stepText,
      calls: findCalls(doc, p, l, stepEnd),
      declared: findDeclared(doc, p, l, stepEnd),
      handler: handlers.at(-1) && { line: handlers.at(-1)!.line, text: handlers.at(-1)!.text },
    };
    for (const t of p.throws) {
      const m = stepText.match(t.re);
      if (m) step.throwsSelf = t.name(m);
    }
    for (const t of p.mayThrow ?? []) if (t.re.test(stepText) && !step.throwsSelf) step.mayThrow = t.name;
    if (isBranch && /^(if|match|switch)$/.test(isBranch.label)) step.branches = branchesAfter(doc, p, l, endLine);
    if (isTry) {
      const h = findHandlerLine(doc, p, l, endLine, indent);
      if (h) handlers.push({ line: h, text: doc.lineAt(h - 1).text.trim().replace(/[\s:{]+$/, ''), indent });
    }
    steps.push(step);
    l = stepEnd + 1;
  }
  return steps;
}

/** The `then`/`else`/`case` bodies following a branch head, as line ranges (indent- or brace-delimited). */
function branchesAfter(doc: vscode.TextDocument, p: KeywordProfile, headLine: number, endLine: number): Branch[] | undefined {
  const headIndent = doc.lineAt(headLine - 1).firstNonWhitespaceCharacterIndex;
  const out: Branch[] = [];
  let label = 'then';
  let from = headLine + 1;
  for (let l = headLine + 1; l <= endLine; l++) {
    const tl = doc.lineAt(l - 1);
    if (tl.isEmptyOrWhitespace) continue;
    const indent = tl.firstNonWhitespaceCharacterIndex;
    const atHead = p.indentBased ? indent <= headIndent : indent === headIndent && /^\s*}/.test(tl.text);
    if (!atHead) continue;
    const clause = p.branch.find((b) => b.re.test(tl.text) && b.label !== 'if' && b.label !== 'match' && b.label !== 'switch');
    out.push({ label, from, to: l - (clause && !p.indentBased ? 0 : 1) });
    if (!clause) break;
    label = tl.text.trim().replace(/^}\s*/, '').replace(/[\s:{]+$/, '').slice(0, 30);
    from = l + 1;
  }
  return out.length > 1 ? out : undefined;
}

function findHandlerLine(doc: vscode.TextDocument, p: KeywordProfile, tryLine: number, endLine: number, indent: number): number | undefined {
  for (let l = tryLine + 1; l <= endLine; l++) {
    const tl = doc.lineAt(l - 1);
    if (tl.isEmptyOrWhitespace) continue;
    if (p.indentBased && tl.firstNonWhitespaceCharacterIndex < indent) return undefined;
    if (p.try?.handler.test(tl.text) && (!p.indentBased || tl.firstNonWhitespaceCharacterIndex === indent)) return l;
  }
  return undefined;
}

const CALL = /\b([A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)*)\s*!?\(/g;

function findCalls(doc: vscode.TextDocument, p: KeywordProfile, from: number, to: number): CallSite[] {
  const out: CallSite[] = [];
  for (let l = from; l <= to; l++) {
    const text = doc.lineAt(l - 1).text;
    for (const m of text.matchAll(CALL)) {
      const name = m[1];
      const last = name.split(/\.|::|->/).pop()!;
      if (p.notCalls.has(last) || p.notCalls.has(name)) continue;
      out.push({ name, position: new vscode.Position(l - 1, (m.index ?? 0) + name.length - last.length) });
    }
  }
  return out;
}

function findDeclared(doc: vscode.TextDocument, p: KeywordProfile, from: number, to: number): Step['declared'] {
  const out: Step['declared'] = [];
  for (let l = from; l <= to; l++) {
    const text = doc.lineAt(l - 1).text;
    for (const re of p.decl) {
      const m = text.match(re);
      if (m?.[1]) out.push({ name: m[1], position: new vscode.Position(l - 1, m.index! + m[0].indexOf(m[1])) });
    }
  }
  return out;
}

import * as vscode from 'vscode';
import { Explainer, StatementContext } from './explain';
import { Frame, Step, frameAt, hoverText, resolveProjectCallee, typeDefinitionText } from './navigator';
import { TestIndex } from './tests';

const STDLIB = /^(console|Math|JSON|Object|Array|Promise|String|Number|Date|Map|Set|parseInt|parseFloat|fetch|setTimeout)\b/;

/** Everything deterministic the context builder needs besides the LSP. */
export interface ContextSources {
  explainer: Explainer;
  tests: TestIndex;
}

/** Errors a statement can raise: its own `throw` plus the throw sites of its project callees. No LLM. */
export async function stepThrows(frame: Frame, step: Step): Promise<string[]> {
  const out: string[] = [];
  if (step.throwsSelf) out.push(step.throwsSelf);
  if (step.mayThrow) out.push(`${step.mayThrow} (conditional)`);
  for (const call of step.calls) {
    if (STDLIB.test(call.name)) continue;
    const loc = await resolveProjectCallee(frame.uri, call);
    if (!loc) continue;
    const target = await vscode.workspace.openTextDocument(loc.uri);
    const callee = frameAt(target, loc.range.start.line + 1);
    if (callee) out.push(...callee.throws.map((t) => `${t} (from ${call.name})`));
  }
  return out;
}

/**
 * Build the minimal context for one statement: only resolve what is opaque.
 * Explicit lines get the enclosing function and nothing else.
 */
export async function buildContext(frame: Frame, step: Step, src: ContextSources): Promise<StatementContext> {
  const callees: string[] = [];
  const hovers: string[] = [];
  const throws = await stepThrows(frame, step);

  for (const call of step.calls) {
    if (STDLIB.test(call.name)) continue;
    const loc = await resolveProjectCallee(frame.uri, call);
    if (loc) {
      // Project function: feed its cached one-line summary (works better than raw code on a 3B).
      const target = await vscode.workspace.openTextDocument(loc.uri);
      const callee = frameAt(target, loc.range.start.line + 1);
      if (callee) {
        const summary = await summarizeFrame(callee, src, definitionDepth() - 1);
        callees.push(`${call.name}: ${summary}`);
        continue;
      }
    }
    // Member call on something we cannot resolve: the type from hover is usually enough.
    if (call.name.includes('.')) {
      const h = await hoverText(frame.uri, call.position);
      if (h) hovers.push(`${call.name}: ${h}`);
    }
  }

  // Types of the variables this statement declares drive the example values; expand project types.
  const vars: string[] = [];
  for (const d of step.declared) {
    const h = await hoverText(frame.uri, d.position);
    const type = h?.replace(/^\(?(const|let|var)\)?\s*[\w$]+:\s*/, '') ?? 'unknown';
    const expanded = await typeDefinitionText(frame.uri, d.position);
    vars.push(`${d.name}: ${type}${expanded.length ? ' — ' + expanded.join(' ; ') : ''}`);
  }

  return {
    enclosing: trimAround(frame, step),
    statement: step.text,
    callees,
    hovers,
    vars,
    throws,
    tests: await src.tests.titlesFor(frame.name),
    reason: frame.reason,
  };
}

/** How many go-to-definition levels to resolve below the current statement. */
function definitionDepth(): number {
  return vscode.workspace.getConfiguration('explain.context').get<number>('definitionDepth', 2);
}

/**
 * One-line summary of a function, informed by the summaries of its own project callees
 * down to `depth` levels, its throw sites and the tests that describe it.
 * Without those facts a small model invents behaviour.
 */
export async function summarizeFrame(
  frame: Frame,
  src: ContextSources,
  depth: number,
  visited = new Set<string>(),
): Promise<string> {
  const key = `${frame.uri.fsPath}:${frame.startLine}`;
  visited.add(key);
  const hints: string[] = [];
  if (depth > 0) {
    const seen = new Set<string>();
    const calls = frame.steps.flatMap((s) => s.calls).filter((c) => !STDLIB.test(c.name) && !seen.has(c.name) && seen.add(c.name));
    const results = await Promise.all(
      calls.map(async (call) => {
        const loc = await resolveProjectCallee(frame.uri, call);
        if (!loc) return undefined;
        const doc = await vscode.workspace.openTextDocument(loc.uri);
        const callee = frameAt(doc, loc.range.start.line + 1);
        if (!callee || visited.has(`${callee.uri.fsPath}:${callee.startLine}`)) return undefined;
        return `${call.name}: ${await summarizeFrame(callee, src, depth - 1, visited)}`;
      }),
    );
    hints.push(...results.filter((r): r is string => !!r));
  }
  if (frame.throws.length) hints.push(`throws: ${frame.throws.join(', ')}`);
  const tests = await src.tests.titlesFor(frame.name, 4);
  if (tests.length) hints.push(`tests: ${tests.join(' / ')}`);
  return src.explainer.summarizeFunction(frame.source, frame.reason, hints);
}

/**
 * The whole function with the current statement marked ">>", so "Why" can use what comes
 * after. Long functions get a window (explain.context.before/after) around the statement.
 */
function trimAround(frame: Frame, step: Step): string {
  const cfg = vscode.workspace.getConfiguration('explain.context');
  const before = cfg.get<number>('before', 15);
  const after = cfg.get<number>('after', 8);
  const maxFull = cfg.get<number>('fullFunctionMaxLines', 60);

  const lines = frame.source.split('\n');
  const from = step.line - frame.startLine;
  const to = step.endLine - frame.startLine;
  const marked = lines.map((l, i) => (i >= from && i <= to ? '>>' + l.slice(2) : l));
  if (lines.length <= maxFull) return marked.join('\n');

  const lo = Math.max(1, from - before);
  const hi = Math.min(lines.length - 1, to + after);
  return [marked[0], ...(lo > 1 ? ['  …'] : []), ...marked.slice(lo, hi + 1), ...(hi < lines.length - 1 ? ['  …', '}'] : [])].join('\n');
}

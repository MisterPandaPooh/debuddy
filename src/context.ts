import * as vscode from 'vscode';
import { Explainer, StatementContext } from './explain';
import { Frame, Step, frameAt, hoverText, resolveProjectCallee } from './navigator';

const STDLIB = /^(console|Math|JSON|Object|Array|Promise|String|Number|Date|Map|Set|parseInt|parseFloat|fetch|setTimeout)\b/;

/**
 * Build the minimal context for one statement: only resolve what is opaque.
 * Explicit lines get the enclosing function and nothing else.
 */
export async function buildContext(frame: Frame, step: Step, explainer: Explainer): Promise<StatementContext> {
  const callees: string[] = [];
  const hovers: string[] = [];

  for (const call of step.calls) {
    if (STDLIB.test(call.name)) continue;
    const loc = await resolveProjectCallee(frame.uri, call);
    if (loc) {
      // Project function: feed its cached one-line summary (works better than raw code on a 3B).
      const target = await vscode.workspace.openTextDocument(loc.uri);
      const callee = frameAt(target, loc.range.start.line + 1);
      if (callee) {
        const summary = await explainer.summarizeFunction(callee.source, '');
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

  // Types of the variables this statement declares drive the example values.
  const vars: string[] = [];
  for (const d of step.declared) {
    const h = await hoverText(frame.uri, d.position);
    vars.push(`${d.name}: ${h?.replace(/^\(?(const|let|var)\)?\s*[\w$]+:\s*/, '') ?? 'unknown'}`);
  }

  return {
    enclosing: trimAround(frame, step),
    statement: step.text,
    callees,
    hovers,
    vars,
    reason: frame.reason,
  };
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

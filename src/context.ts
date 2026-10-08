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

  return {
    enclosing: trimAround(frame, step),
    statement: step.text,
    callees,
    hovers,
    reason: frame.reason,
  };
}

/** Signature + a few lines before the step; lines after are cut so the model does not peek ahead. */
function trimAround(frame: Frame, step: Step): string {
  const lines = frame.source.split('\n');
  const rel = step.line - frame.startLine;
  const from = Math.max(1, rel - 4);
  const to = Math.min(lines.length - 1, step.endLine - frame.startLine + 1);
  const body = lines.slice(from, to + 1);
  return [lines[0], ...(from > 1 ? ['  …'] : []), ...body, ...(to < lines.length - 1 ? ['  …', '}'] : [])].join('\n');
}

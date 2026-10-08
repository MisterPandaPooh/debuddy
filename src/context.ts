import * as vscode from 'vscode';
import { Explainer, StatementContext } from './explain';
import { Frame, Step, calleeFrame, hoverText, typeDefinitionText } from './lang';
import { TestIndex } from './tests';

const STDLIB = /^(console|Math|JSON|Object|Array|Promise|String|Number|Date|Map|Set|parseInt|parseFloat|fetch|setTimeout)\b/;

/** Everything deterministic the context builder needs besides the LSP. */
export interface ContextSources {
  explainer: Explainer;
  tests: TestIndex;
  /** Seconds-per-call provider: spend tokens, not round-trips (raw callee code instead of summaries). */
  slow?: () => boolean;
}

/** Errors a statement can raise: its own `throw` plus the throw sites of its project callees. No LLM. */
export async function stepThrows(frame: Frame, step: Step): Promise<string[]> {
  const out: string[] = [];
  if (step.throwsSelf) out.push(step.throwsSelf);
  if (step.mayThrow) out.push(`${step.mayThrow} (conditional)`);
  for (const call of step.calls) {
    if (STDLIB.test(call.name)) continue;
    const callee = await calleeFrame(frame.uri, call);
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
    const callee = await calleeFrame(frame.uri, call);
    {
      // Project function: feed its cached one-line summary (works better than raw code on a 3B).
      if (callee) {
        if (src.slow?.()) {
          // One round-trip matters more than tokens: a big model reads the callee itself.
          callees.push(`${call.name}:\n${excerpt(callee.source, 25)}`);
        } else {
          const summary = await summarizeFrame(callee, src, definitionDepth() - 1);
          callees.push(`${call.name}: ${summary}`);
        }
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

/** Everything the model needs to explain every statement of a function, resolved once (LSP only). */
export interface FunctionContext {
  name: string;
  file: string;
  /** Source with 1-based line numbers prefixed. */
  numbered: string;
  /** "L<line>: <text>" for each step, in order. */
  statements: { line: number; text: string }[];
  /** Deduplicated project callees with a code excerpt. */
  callees: string[];
  hovers: string[];
  /** "name: type — expanded" for every declared variable, prefixed by its line. */
  vars: string[];
  /** "Error (from fn) at L<line>". */
  throws: string[];
  tests: string[];
  reason: string;
}

export async function buildFunctionContext(frame: Frame, src: ContextSources): Promise<FunctionContext> {
  const callees = new Map<string, string>();
  const hovers: string[] = [];
  const vars: string[] = [];
  const throws: string[] = [];
  for (const step of frame.steps) {
    for (const call of step.calls) {
      if (STDLIB.test(call.name) || callees.has(call.name)) continue;
      const callee = await calleeFrame(frame.uri, call);
      {
        if (callee) {
          callees.set(call.name, `${call.name}:\n${excerpt(callee.source, 25)}`);
          throws.push(...callee.throws.map((t) => `${t} (from ${call.name}) at L${step.line}`));
          continue;
        }
      }
      if (call.name.includes('.')) {
        const h = await hoverText(frame.uri, call.position);
        if (h) hovers.push(`${call.name}: ${h}`);
      }
    }
    if (step.throwsSelf) throws.push(`${step.throwsSelf} at L${step.line}`);
    if (step.mayThrow) throws.push(`${step.mayThrow} (conditional) at L${step.line}`);
    for (const d of step.declared) {
      const h = await hoverText(frame.uri, d.position);
      const type = h?.replace(/^\(?(const|let|var)\)?\s*[\w$]+:\s*/, '') ?? 'unknown';
      const expanded = await typeDefinitionText(frame.uri, d.position);
      vars.push(`L${step.line} ${d.name}: ${type}${expanded.length ? ' — ' + expanded.join(' ; ') : ''}`);
    }
  }
  const numbered = frame.source.split('\n').map((l, i) => `${String(frame.startLine + i).padStart(4)}  ${l}`).join('\n');
  return {
    name: frame.name,
    file: frame.uri.fsPath.split('/').pop() ?? '',
    numbered,
    statements: frame.steps.map((s) => ({ line: s.line, text: s.text.split('\n')[0] })),
    callees: [...callees.values()],
    hovers,
    vars,
    throws,
    tests: await src.tests.titlesFor(frame.name),
    reason: frame.reason,
  };
}

/** First `n` lines of a function, with an ellipsis when cut. */
function excerpt(source: string, n: number): string {
  const lines = source.split('\n');
  return lines.length <= n ? source : [...lines.slice(0, n), '  …', '}'].join('\n');
}

/** How many go-to-definition levels to resolve below the current statement. */
function definitionDepth(): number {
  return vscode.workspace.getConfiguration('explain.context').get<number>('definitionDepth', 2);
}

/** One-line summary of a function from its callees' summaries (to `depth`), throw sites and tests —
 * without those facts a small model invents behaviour. */
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
        const callee = await calleeFrame(frame.uri, call);
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

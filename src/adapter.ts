import * as path from 'path';
import * as vscode from 'vscode';
import {
  ContinuedEvent,
  DebugSession,
  InitializedEvent,
  InvalidatedEvent,
  Scope,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { ContextSources, buildContext, stepThrows, summarizeFrame } from './context';
import { ExampleValue, Explanation, StatementContext } from './explain';
import { Frame, Step, frameAt, hoverText, referencesOf, resolveProjectCallee } from './navigator';
import { ExplainUi, ShowOptions } from './ui';

const THREAD_ID = 1;

interface Prepared {
  ctx: StatementContext;
  explanation: Explanation;
  values: Promise<ExampleValue[]>;
}
const BANNER = '⚠️ _Static walkthrough: nothing is executed. Values are illustrative, branches are read in source order._';

interface LaunchArgs extends DebugProtocol.LaunchRequestArguments {
  file: string;
  line: number;
}

/**
 * A debug adapter that runs nothing: "execution" is walking statements of the AST.
 * This buys the native debug toolbar, F10/F11, the call stack view and breakpoints for free.
 */
export class ExplainSession extends DebugSession {
  private stack: Frame[] = [];
  private breakpoints = new Map<string, Set<number>>();
  private explanation?: Explanation;
  private values: ExampleValue[] = [];
  private context?: StatementContext;
  /** Snapshots of (frame, index) per stop, for Step Back / Reverse Continue. */
  private history: { stack: Frame[]; indices: number[]; reason: string }[] = [];
  private firstStop = true;
  private explainToken = 0;
  /** Explanations by statement, so the next step (prefetched) and Step Back are instant. */
  private prepared = new Map<string, Promise<Prepared>>();
  /** The running auto-walk, if any; cancelled by Pause, breakpoints, end or disconnect. */
  private auto?: { cancelled: boolean; wake: () => void };
  /** Exception breakpoint filters chosen in the Breakpoints view. */
  private exceptionFilters = new Set<string>();
  /** What the current statement can throw (deterministic), for the 💥 button and the UI. */
  private currentThrows: string[] = [];

  constructor(private ui: ExplainUi, private src: ContextSources) {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  private get top(): Frame {
    return this.stack[this.stack.length - 1];
  }

  protected dispatchRequest(request: DebugProtocol.Request): void {
    this.log(`← ${request.command}${request.command === 'setBreakpoints' ? ' ' + JSON.stringify(request.arguments) : ''}`);
    super.dispatchRequest(request);
  }

  protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
    response.body = {
      supportsConfigurationDoneRequest: true,
      supportsStepBack: true,
      supportsEvaluateForHovers: true,
      supportsFunctionBreakpoints: true,
      exceptionBreakpointFilters: [
        { filter: 'throw', label: 'Throw statements', description: 'Stop on every `throw`', default: false },
        { filter: 'mayThrow', label: 'Calls that may throw', description: 'Stop on calls to project functions that contain a throw', default: false },
      ],
    };
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchArgs) {
    const doc = await vscode.workspace.openTextDocument(args.file);
    const frame = frameAt(doc, args.line);
    if (!frame) {
      this.sendErrorResponse(response, 1, `No function found at ${path.basename(args.file)}:${args.line}`);
      return;
    }
    this.stack = [frame];
    this.sendResponse(response);
    void this.stopAt('entry', true);
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = { threads: [new Thread(THREAD_ID, 'Explain (static walkthrough)')] };
    this.sendResponse(response);
  }

  protected stackTraceRequest(response: DebugProtocol.StackTraceResponse): void {
    const frames = [...this.stack].reverse().map((f, i) => {
      const step = f.steps[f.index];
      const src = new Source(path.basename(f.uri.fsPath), f.uri.fsPath);
      return new StackFrame(i, `${f.name}()`, src, step.line, 1);
    });
    response.body = { stackFrames: frames, totalFrames: frames.length };
    this.sendResponse(response);
  }

  protected scopesRequest(response: DebugProtocol.ScopesResponse): void {
    response.body = {
      scopes: [new Scope('Explanation', 1, false), new Scope('Example values (not runtime)', 2, false)],
    };
    this.sendResponse(response);
  }

  protected variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments,
  ): void {
    const v = (name: string, value: string) => ({ name, value, variablesReference: 0 });
    if (args.variablesReference === 2) {
      const step = this.top?.steps[this.top.index];
      response.body = {
        variables: this.values.length
          ? this.values.map((x) => v(x.name, x.alternative ? `${x.example}   | ${x.alternative}` : x.example))
          : [v(step?.declared.length ? 'Status' : '(none)', step?.declared.length ? 'thinking…' : 'statement declares nothing')],
      };
    } else {
      const e = this.explanation;
      response.body = {
        variables: e ? [v('Does', e.does), v('Why', e.why), v('Watch', e.watch || '-')] : [v('Status', 'explaining…')],
      };
    }
    this.sendResponse(response);
  }

  /** Function breakpoints: stop when entering a function with one of these names. */
  private functionBreakpoints = new Set<string>();

  protected setFunctionBreakPointsRequest(
    response: DebugProtocol.SetFunctionBreakpointsResponse,
    args: DebugProtocol.SetFunctionBreakpointsArguments,
  ): void {
    this.functionBreakpoints = new Set(args.breakpoints.map((b) => b.name.replace(/\(\)$/, '')));
    response.body = { breakpoints: args.breakpoints.map(() => ({ verified: true })) };
    this.sendResponse(response);
  }

  /**
   * Hover on an identifier shows its example value or type; the Debug Console asks the model.
   * Only a hover with nothing to say errors (silently: VS Code then shows the language hover).
   */
  protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
    const expr = args.expression.trim();
    const ok = (result: string) => {
      response.body = { result, variablesReference: 0 };
      this.sendResponse(response);
    };
    try {
      if (args.context === 'repl') {
        if (!this.context) return ok('Still explaining this statement — ask again in a moment.');
        return ok(await this.src.explainer.answer(this.context, expr));
      }
      const known = this.values.find((x) => x.name === expr);
      const type = this.context?.vars.find((x) => x.startsWith(`${expr}:`)) ?? (await this.typeOfLocal(expr));
      if (known || type) {
        const parts = [type ?? expr, known ? `example: ${known.example}` : '', known?.alternative ? `or: ${known.alternative}` : ''];
        return ok(parts.filter(Boolean).join('\n'));
      }
      if (args.context === 'hover') return this.sendErrorResponse(response, 2, 'not a variable of this walkthrough');
      ok(`${expr}: not a variable declared in ${this.top?.name ?? 'this function'}() (static walkthrough, no runtime values)`);
    } catch (err) {
      this.log(`evaluate: ${err}`);
      ok(`(unavailable: ${err instanceof Error ? err.message : String(err)})`);
    }
  }

  /** Type of a variable declared anywhere in the current function, via the LSP hover at its declaration. */
  private async typeOfLocal(name: string): Promise<string | undefined> {
    const frame = this.top;
    if (!frame) return undefined;
    for (const s of frame.steps) {
      const d = s.declared.find((x) => x.name === name);
      if (!d) continue;
      const h = await hoverText(frame.uri, d.position);
      if (h) return `${name}: ${h.replace(/^\(?(const|let|var)\)?\s*[\w$]+:\s*/, '')}`;
    }
    return undefined;
  }

  protected stepBackRequest(response: DebugProtocol.StepBackResponse): void {
    this.sendResponse(response);
    this.history.pop(); // current position
    const prev = this.history.pop();
    if (!prev) return void this.stopAt('step');
    this.restore(prev);
    void this.stopAt('step');
  }

  protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse): void {
    this.sendResponse(response);
    this.history.pop();
    let prev = this.history.pop();
    while (prev && this.history.length && !['breakpoint', 'entry'].includes(prev.reason)) prev = this.history.pop();
    if (prev) this.restore(prev);
    void this.stopAt(prev?.reason === 'breakpoint' ? 'breakpoint' : 'step');
  }

  private restore(snap: { stack: Frame[]; indices: number[] }) {
    this.stack = [...snap.stack];
    snap.stack.forEach((f, i) => (f.index = snap.indices[i]));
  }

  protected setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
    const lines = (args.breakpoints ?? []).map((b) => b.line);
    this.breakpoints.set(args.source.path ?? '', new Set(lines));
    this.log(`breakpoints ${path.basename(args.source.path ?? '?')}: ${lines.join(', ') || 'none'}`);
    response.body = { breakpoints: lines.map((line) => ({ verified: true, line })) };
    this.sendResponse(response);
  }

  protected async nextRequest(response: DebugProtocol.NextResponse) {
    this.sendResponse(response);
    // A `throw` statement always throws: the next step is wherever the exception lands.
    if (this.top.steps[this.top.index].throwsSelf) return this.followThrow();
    await this.askBranch();
    this.moveNext() ? void this.stopAt('step') : this.end();
  }

  /** On an `if` head, let the user pick a path; the other branch is skipped in this frame. */
  private async askBranch() {
    const frame = this.top;
    const step = frame.steps[frame.index];
    if (!step.branches || !vscode.workspace.getConfiguration('explain').get<boolean>('askBranch', true)) return;
    const choice = await this.ui.pickBranch(step);
    if (!choice) return;
    frame.skip.push(...step.branches.filter((b) => b !== choice));
    this.log(`branch: ${choice.label} (skipping ${step.branches.filter((b) => b !== choice).map((b) => b.label).join(', ') || 'nothing'})`);
  }

  protected setExceptionBreakPointsRequest(
    response: DebugProtocol.SetExceptionBreakpointsResponse,
    args: DebugProtocol.SetExceptionBreakpointsArguments,
  ): void {
    this.exceptionFilters = new Set(args.filters);
    this.log(`exception filters: ${args.filters.join(', ') || 'none'}`);
    this.sendResponse(response);
  }

  /** Exception breakpoints: a `throw` statement, or a call whose project callee contains one. */
  private async atExceptionBreakpoint(): Promise<boolean> {
    if (!this.exceptionFilters.size) return false;
    const step = this.top.steps[this.top.index];
    if (this.exceptionFilters.has('throw') && step.throwsSelf) return true;
    if (this.exceptionFilters.has('mayThrow') && step.calls.length) {
      return (await stepThrows(this.top, step)).some((t) => t.includes('(from '));
    }
    return false;
  }

  /**
   * Follow the exception from the current statement: jump to the enclosing `catch`, or unwind
   * the call stack to the first caller that has one, or report that it leaves the entry point.
   */
  private followThrow() {
    this.unwindToHandler();
    void this.stopAt('exception');
  }

  /** Move to where an exception from the current statement lands; false when nothing catches it. */
  private unwindToHandler(): boolean {
    const what = this.currentThrows[0] ?? 'the exception';
    this.history.push({ stack: [...this.stack], indices: this.stack.map((f) => f.index), reason: 'throw' });
    const unwound: string[] = [];
    while (this.stack.length) {
      const frame = this.top;
      const step = frame.steps[frame.index];
      if (step.handler) {
        const target = frame.steps.findIndex((s) => s.line === step.handler!.line && s.text === step.handler!.text);
        if (target >= 0) {
          frame.index = target;
          const via = unwound.length ? ` after leaving ${unwound.join(' → ')}` : '';
          this.pendingHeader = `💥 **${what}** thrown at L${step.line}${via} — caught here`;
          this.log(`throw: ${what} → ${step.handler.text} L${step.handler.line}`);
          return true;
        }
      }
      if (this.stack.length === 1) {
        // No handler anywhere: stay put and say so.
        this.pendingHeader = `💥 **${what}** is not caught${unwound.length ? ` in ${unwound.join(' → ')} nor` : ''} here — it leaves ${frame.name}() to its caller`;
        this.log(`throw: ${what} unhandled, leaves ${frame.name}()`);
        return false;
      }
      unwound.push(`${frame.name}()`);
      this.stack.pop();
    }
    return false;
  }

  /** `autoWalk` / `followThrow` are sent by the toolbar buttons; VS Code is told when the thread runs. */
  protected customRequest(command: string, response: DebugProtocol.Response, args: unknown): void {
    if (command === 'followThrow') {
      this.sendResponse(response);
      this.cancelAuto();
      if (this.stack.length) void this.followThrow();
      return;
    }
    if (command === 'expand') {
      this.sendResponse(response);
      void this.expand();
      return;
    }
    if (command !== 'autoWalk') return super.customRequest(command, response, args);
    this.sendResponse(response);
    this.log(`autoWalk requested (auto already running: ${!!this.auto}, stack: ${this.stack.length})`);
    if (this.auto || !this.stack.length) return;
    this.sendEvent(new ContinuedEvent(THREAD_ID));
    void this.autoWalk();
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse): void {
    this.sendResponse(response);
    if (!this.cancelAuto()) return;
    void this.stopAt('pause');
  }

  private cancelAuto(): boolean {
    if (!this.auto) return false;
    this.auto.cancelled = true;
    this.auto.wake();
    this.auto = undefined;
    this.ui.setAutoStatus(false);
    this.ui.clearHighlight();
    return true;
  }

  /** Auto mode: advance and explain every statement, pausing on breakpoints or F6. */
  private async autoWalk() {
    const run = { cancelled: false, wake: () => {} };
    this.auto = run;
    this.ui.setAutoStatus(true);
    const dwell = vscode.workspace.getConfiguration('explain.auto').get<number>('dwellMs', 3000);
    this.log(`auto: start (dwell ${dwell} ms)`);
    try {
      await this.autoLoop(run, dwell);
    } catch (err) {
      this.log(`auto: crashed — ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (this.auto === run) {
        this.cancelAuto();
        void this.stopAt('exception');
      }
    }
  }

  private async autoLoop(run: { cancelled: boolean; wake: () => void }, dwell: number) {
    for (let guard = 0; guard < 5000 && !run.cancelled; guard++) {
      let entered = false;
      if (await this.enterCalleeWithBreakpoint()) {
        if (this.functionBreakpoints.has(this.top.name) || this.atBreakpoint()) {
          this.cancelAuto();
          return void this.stopAt(this.atBreakpoint() ? 'breakpoint' : 'function breakpoint', true);
        }
        entered = true;
      } else if (this.top.steps[this.top.index].throwsSelf) {
        // Auto-walk follows a certain throw instead of reading unreachable code.
        if (!this.unwindToHandler()) {
          this.cancelAuto();
          return void this.stopAt('exception');
        }
      } else {
        if (this.atLastStep()) {
          this.cancelAuto();
          return void this.stopAt('end');
        }
        this.moveNext();
        if (this.atBreakpoint()) {
          this.cancelAuto();
          return void this.stopAt('breakpoint');
        }
        if (await this.atExceptionBreakpoint()) {
          this.cancelAuto();
          return void this.stopAt('exception');
        }
      }
      if (run.cancelled) return;
      this.history.push({ stack: [...this.stack], indices: this.stack.map((f) => f.index), reason: 'auto' });
      const frame = this.top;
      const step = frame.steps[frame.index];
      const bps = [...(this.breakpoints.get(frame.uri.fsPath) ?? [])];
      this.log(`auto ${frame.name}() L${step.line}: ${step.text.split('\n')[0]}  (bps in file: ${bps.join(', ') || 'none'})`);
      await this.ui.highlight(frame.uri, step.line);
      await this.present('auto', entered);
      if (run.cancelled) return;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, dwell);
        run.wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  }

  protected async stepInRequest(response: DebugProtocol.StepInResponse) {
    this.sendResponse(response);
    const caller = this.top;
    const step = caller.steps[caller.index];
    for (const call of step.calls) {
      const loc = await resolveProjectCallee(caller.uri, call);
      if (!loc) continue;
      const doc = await vscode.workspace.openTextDocument(loc.uri);
      const reason = `stepped into from ${caller.name}(), which runs: ${step.text}`;
      const frame = frameAt(doc, loc.range.start.line + 1, reason);
      if (!frame) continue;
      this.stack.push(frame);
      void this.stopAt(this.functionBreakpoints.has(frame.name) ? 'function breakpoint' : 'step', true);
      return;
    }
    // Nothing to enter: behave like Step Over.
    this.moveNext() ? void this.stopAt('step') : this.end();
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse): void {
    this.sendResponse(response);
    this.stack.pop();
    if (this.stack.length === 0) return this.end();
    this.moveNext() ? void this.stopAt('step') : this.end();
  }

  protected async continueRequest(response: DebugProtocol.ContinueResponse) {
    this.sendResponse(response);
    if (vscode.workspace.getConfiguration('explain.auto').get<boolean>('enabled', false)) return this.autoWalk();
    const wasAtEnd = this.atLastStep();
    // Walk until a breakpoint; enter project callees that contain one so a
    // breakpoint in another function is reachable from the entry point.
    for (let guard = 0; guard < 5000; guard++) {
      if (await this.enterCalleeWithBreakpoint()) {
        if (this.functionBreakpoints.has(this.top.name)) return void this.stopAt('function breakpoint', true);
        if (this.atBreakpoint()) return void this.stopAt('breakpoint', true);
        continue;
      }
      if (this.atLastStep()) break;
      this.moveNext();
      if (this.atBreakpoint()) return void this.stopAt('breakpoint');
      if (await this.atExceptionBreakpoint()) return void this.stopAt('exception');
    }
    // No breakpoint ahead: park on the last statement instead of vanishing silently.
    if (this.stack.length && !wasAtEnd) return void this.stopAt('end');
    this.end();
  }

  private atLastStep(): boolean {
    return this.stack.length === 1 && this.top.index === this.top.steps.length - 1;
  }

  /** If the current statement calls a project function holding a breakpoint, step into it. */
  private async enterCalleeWithBreakpoint(): Promise<boolean> {
    const caller = this.top;
    const step = caller.steps[caller.index];
    for (const call of step.calls) {
      const loc = await resolveProjectCallee(caller.uri, call);
      if (!loc) continue;
      const bps = this.breakpoints.get(loc.uri.fsPath);
      const doc = await vscode.workspace.openTextDocument(loc.uri);
      const frame = frameAt(doc, loc.range.start.line + 1, `stepped into from ${caller.name}(), which runs: ${step.text}`);
      if (!frame) continue;
      const last = frame.steps[frame.steps.length - 1];
      const hasLine = [...(bps ?? [])].some((l) => l >= frame.startLine && l <= last.endLine);
      if (!hasLine && !this.functionBreakpoints.has(frame.name)) continue;
      // Never re-enter a frame already on the stack (recursion).
      if (this.stack.some((f) => f.uri.fsPath === frame.uri.fsPath && f.startLine === frame.startLine)) continue;
      this.stack.push(frame);
      this.log(`continue: entered ${frame.name}() for breakpoint`);
      return true;
    }
    return false;
  }

  protected disconnectRequest(response: DebugProtocol.DisconnectResponse): void {
    this.explainToken++;
    this.cancelAuto();
    this.ui.clear();
    this.sendResponse(response);
  }

  /** Advance to the next statement, unwinding finished frames. False when the walk is over. */
  private moveNext(): boolean {
    while (this.stack.length) {
      const f = this.top;
      while (f.index + 1 < f.steps.length) {
        f.index++;
        const s = f.steps[f.index];
        if (!f.skip.some((b) => s.line >= b.from && s.line <= b.to)) return true;
      }
      this.stack.pop();
    }
    return false;
  }

  private atBreakpoint(): boolean {
    const f = this.top;
    const bps = this.breakpoints.get(f.uri.fsPath);
    if (!bps?.size) return false;
    const step = f.steps[f.index];
    const prevEnd = f.index > 0 ? f.steps[f.index - 1].endLine : f.startLine;
    // A breakpoint on a blank line, `}` or `else` snaps forward to this step.
    return [...bps].some((l) => l > prevEnd && l <= step.endLine);
  }

  private log(msg: string) {
    this.ui.log(msg);
  }

  private end() {
    this.log('end of walk, session terminated');
    this.cancelAuto();
    this.ui.clear();
    this.sendEvent(new TerminatedEvent());
  }

  /** Report the stop to VS Code, then explain the statement and refresh the UI. */
  private async stopAt(reason: string, entered = false) {
    const frame = this.top;
    const step = frame.steps[frame.index];
    this.history.push({ stack: [...this.stack], indices: this.stack.map((f) => f.index), reason });
    this.log(`stop(${reason}) ${frame.name}() L${step.line}: ${step.text.split('\n')[0]}`);
    this.ui.clearHighlight();
    this.sendEvent(new StoppedEvent(reason, THREAD_ID));
    await this.present(reason, entered);
  }

  /** One-shot header for the next presentation (set by followThrow). */
  private pendingHeader?: string;
  /** What the thread currently shows, so "expand" can re-render it with the long form appended. */
  private shown?: { uri: vscode.Uri; line: number; explanation: Explanation; opts: ShowOptions };

  /** Re-explain the current statement with the expand provider and append it to the thread. */
  private async expand() {
    const ctx = this.context;
    const shown = this.shown;
    if (!ctx || !shown) return void vscode.window.setStatusBarMessage('Explain: nothing to expand yet', 3000);
    const token = this.explainToken;
    const dispose = vscode.window.setStatusBarMessage(`$(sync~spin) Explain: asking ${this.src.providerName('expand')}…`);
    try {
      const more = await this.src.explainer.expand(ctx);
      if (token !== this.explainToken) return;
      this.ui.show(shown.uri, shown.line, shown.explanation, { ...shown.opts, more });
    } catch (err) {
      this.log(`expand: ${err}`);
      void vscode.window.showErrorMessage(`Expand failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      dispose.dispose();
    }
  }

  /** Explain the current statement and refresh the UI; shared by stops and auto mode. */
  private async present(reason: string, entered: boolean) {
    const frame = this.top;
    const step = frame.steps[frame.index];
    const token = ++this.explainToken;
    this.explanation = undefined;
    this.values = [];
    this.context = undefined;
    this.currentThrows = await stepThrows(frame, step);
    void vscode.commands.executeCommand('setContext', 'explain.canThrow', this.currentThrows.length > 0);
    const lands = this.currentThrows.length
      ? step.handler
        ? `caught by \`${step.handler.text}\` L${step.handler.line}`
        : `propagates out of ${frame.name}()${this.stack.length > 1 ? ` to ${this.stack[this.stack.length - 2].name}()` : ' (unhandled here)'}`
      : undefined;
    try {
      let header = entered ? await this.frameHeader(frame) : undefined;
      if (this.pendingHeader) {
        header = [this.pendingHeader, header].filter(Boolean).join('\n\n');
        this.pendingHeader = undefined;
      }
      if (this.firstStop) {
        header = [BANNER, header].filter(Boolean).join('\n\n');
        this.firstStop = false;
      }
      if (token !== this.explainToken) return;
      this.ui.showPending(frame.uri, step.line, header);
      const { ctx, explanation, values } = await this.prepare(frame, step);
      if (token !== this.explainToken) return;
      this.context = ctx;
      this.explanation = explanation;
      const footer =
        reason === 'end'
          ? '_End of walk — F5/F10 or Shift+F5 to exit, Shift+F11 to go back up._'
          : reason === 'auto'
            ? '_Auto-walking — F6 or the status bar to pause._'
            : step.branches
              ? '_F10 will ask which branch to follow._'
              : undefined;
      const opts: ShowOptions = { header, footer, throws: ctx.throws, lands };
      this.shown = { uri: frame.uri, line: step.line, explanation, opts };
      this.ui.show(frame.uri, step.line, explanation, opts);
      this.sendEvent(new InvalidatedEvent(['variables'], THREAD_ID));
      // Values are a second local call; let them land after the explanation without blocking it.
      void values.then((v) => {
        if (token !== this.explainToken) return;
        this.values = v;
        this.sendEvent(new InvalidatedEvent(['variables'], THREAD_ID));
      }).catch((err) => this.log(`values: ${err}`));
      // Warm the next statement while the user reads this one; local inference is free.
      const next = this.peekNext();
      if (next) void this.prepare(next.frame, next.step).catch(() => undefined);
    } catch (err) {
      if (token === this.explainToken) this.ui.showError(frame.uri, step.line, err);
    }
  }

  private async frameHeader(frame: Frame): Promise<string> {
    const depth = vscode.workspace.getConfiguration('explain.context').get<number>('definitionDepth', 2);
    const [summary, callers] = await Promise.all([
      summarizeFrame(frame, this.src, depth),
      frame.namePosition ? referencesOf(frame.uri, frame.namePosition) : Promise.resolve([]),
    ]);
    const from = callers.length ? `\n\n_Called from: ${callers.join(', ')}_` : '';
    return `↳ **${frame.name}()** — ${summary}${from}`;
  }

  /** Context + explanation + (pending) values for a statement, computed once per statement text. */
  private prepare(frame: Frame, step: Step): Promise<Prepared> {
    const key = `${frame.uri.fsPath}:${step.line}:${step.text}:${frame.source.length}`;
    let p = this.prepared.get(key);
    if (!p) {
      p = (async () => {
        const ctx = await buildContext(frame, step, this.src);
        const explanation = await this.src.explainer.explainStatement(ctx);
        const values = this.src.explainer.exampleValues(ctx);
        return { ctx, explanation, values };
      })();
      p.catch(() => this.prepared.delete(key));
      this.prepared.set(key, p);
    }
    return p;
  }

  /** Where Step Over would land, without moving. */
  private peekNext(): { frame: Frame; step: Step } | undefined {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const f = this.stack[i];
      if (f.index + 1 < f.steps.length) return { frame: f, step: f.steps[f.index + 1] };
    }
    return undefined;
  }
}

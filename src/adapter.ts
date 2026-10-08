import * as path from 'path';
import * as vscode from 'vscode';
import {
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
import { buildContext } from './context';
import { ExampleValue, Explainer, Explanation, StatementContext } from './explain';
import { Frame, frameAt, resolveProjectCallee } from './navigator';
import { ExplainUi } from './ui';

const THREAD_ID = 1;
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

  constructor(private ui: ExplainUi, private explainer: Explainer) {
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

  /** Hover on an identifier shows its example value; the Debug Console asks the model. */
  protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
    const expr = args.expression.trim();
    try {
      if (args.context === 'repl' && this.context) {
        const text = await this.explainer.answer(this.context, expr);
        response.body = { result: text, variablesReference: 0 };
      } else {
        const known = this.values.find((x) => x.name === expr);
        const type = this.context?.vars.find((x) => x.startsWith(`${expr}:`));
        if (!known && !type) return this.sendErrorResponse(response, 2, 'no example value for this expression');
        const parts = [type ?? expr, known ? `example: ${known.example}` : '', known?.alternative ? `or: ${known.alternative}` : ''];
        response.body = { result: parts.filter(Boolean).join('\n'), variablesReference: 0 };
      }
      this.sendResponse(response);
    } catch (err) {
      this.sendErrorResponse(response, 3, err instanceof Error ? err.message : String(err));
    }
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

  protected nextRequest(response: DebugProtocol.NextResponse): void {
    this.sendResponse(response);
    this.moveNext() ? void this.stopAt('step') : this.end();
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
    this.ui.clear();
    this.sendResponse(response);
  }

  /** Advance to the next statement, unwinding finished frames. False when the walk is over. */
  private moveNext(): boolean {
    while (this.stack.length) {
      const f = this.top;
      if (f.index + 1 < f.steps.length) {
        f.index++;
        return true;
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
    this.ui.clear();
    this.sendEvent(new TerminatedEvent());
  }

  /** Report the stop to VS Code, then explain the statement and refresh the UI. */
  private async stopAt(reason: string, entered = false) {
    const frame = this.top;
    const step = frame.steps[frame.index];
    const token = ++this.explainToken;
    this.explanation = undefined;
    this.values = [];
    this.context = undefined;
    this.history.push({ stack: [...this.stack], indices: this.stack.map((f) => f.index), reason });
    this.log(`stop(${reason}) ${frame.name}() L${step.line}: ${step.text.split('\n')[0]}`);
    this.sendEvent(new StoppedEvent(reason, THREAD_ID));

    try {
      let header = entered ? await this.frameHeader(frame) : undefined;
      if (this.firstStop) {
        header = [BANNER, header].filter(Boolean).join('\n\n');
        this.firstStop = false;
      }
      if (token !== this.explainToken) return;
      this.ui.showPending(frame.uri, step.line, header);
      const ctx = await buildContext(frame, step, this.explainer);
      if (token !== this.explainToken) return;
      this.context = ctx;
      // Values are a second local call; let them land after the explanation without blocking it.
      void this.explainer.exampleValues(ctx).then((values) => {
        if (token !== this.explainToken) return;
        this.values = values;
        this.sendEvent(new InvalidatedEvent(['variables'], THREAD_ID));
      }).catch((err) => this.log(`values: ${err}`));
      const explanation = await this.explainer.explainStatement(ctx);
      if (token !== this.explainToken) return;
      this.explanation = explanation;
      const footer = reason === 'end' ? '_End of walk — F5/F10 or Shift+F5 to exit, Shift+F11 to go back up._' : undefined;
      this.ui.show(frame.uri, step.line, explanation, header, footer);
      this.sendEvent(new InvalidatedEvent(['variables'], THREAD_ID));
    } catch (err) {
      if (token === this.explainToken) this.ui.showError(frame.uri, step.line, err);
    }
  }

  private async frameHeader(frame: Frame): Promise<string> {
    const summary = await this.explainer.summarizeFunction(frame.source, frame.reason);
    return `↳ **${frame.name}()** — ${summary}`;
  }
}

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
import { Explainer, Explanation } from './explain';
import { Frame, frameAt, resolveProjectCallee } from './navigator';
import { ExplainUi } from './ui';

const THREAD_ID = 1;

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
  private explainToken = 0;

  constructor(private ui: ExplainUi, private explainer: Explainer) {
    super();
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  private get top(): Frame {
    return this.stack[this.stack.length - 1];
  }

  protected initializeRequest(response: DebugProtocol.InitializeResponse): void {
    response.body = { supportsConfigurationDoneRequest: true };
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
    response.body = { threads: [new Thread(THREAD_ID, 'Explain')] };
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
    response.body = { scopes: [new Scope('Explanation', 1, false)] };
    this.sendResponse(response);
  }

  protected variablesRequest(response: DebugProtocol.VariablesResponse): void {
    const e = this.explanation;
    const v = (name: string, value: string) => ({ name, value, variablesReference: 0 });
    response.body = {
      variables: e
        ? [v('Does', e.does), v('Why', e.why), v('Watch', e.watch || '-')]
        : [v('Status', 'explaining…')],
    };
    this.sendResponse(response);
  }

  protected setBreakpointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments,
  ): void {
    const lines = (args.breakpoints ?? []).map((b) => b.line);
    this.breakpoints.set(args.source.path ?? '', new Set(lines));
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
      void this.stopAt('step', true);
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

  protected continueRequest(response: DebugProtocol.ContinueResponse): void {
    this.sendResponse(response);
    while (this.moveNext()) {
      if (this.atBreakpoint()) return void this.stopAt('breakpoint');
    }
    this.end();
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
    return this.breakpoints.get(f.uri.fsPath)?.has(f.steps[f.index].line) ?? false;
  }

  private end() {
    this.ui.clear();
    this.sendEvent(new TerminatedEvent());
  }

  /** Report the stop to VS Code, then explain the statement and refresh the UI. */
  private async stopAt(reason: string, entered = false) {
    const frame = this.top;
    const step = frame.steps[frame.index];
    const token = ++this.explainToken;
    this.explanation = undefined;
    this.sendEvent(new StoppedEvent(reason, THREAD_ID));

    try {
      const header = entered ? await this.frameHeader(frame) : undefined;
      if (token !== this.explainToken) return;
      this.ui.showPending(frame.uri, step.line, header);
      const ctx = await buildContext(frame, step, this.explainer);
      const explanation = await this.explainer.explainStatement(ctx);
      if (token !== this.explainToken) return;
      this.explanation = explanation;
      this.ui.show(frame.uri, step.line, explanation, header);
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

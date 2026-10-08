import { spawn } from 'child_process';
import * as vscode from 'vscode';

/** One chat completion. Every provider reduces to this; the prompts live in explain.ts. */
export interface ChatProvider {
  readonly name: string;
  /** Seconds per call rather than milliseconds: callers batch and prefetch more aggressively. */
  readonly slow?: boolean;
  chat(system: string, user: string, maxTokens: number): Promise<string>;
}

export type ProviderKind = 'ollama' | 'openai' | 'vscode-lm' | 'claude-cli' | 'cursor-cli';

/** Ollama's native API (default: local, small, fast). */
export class OllamaProvider implements ChatProvider {
  readonly name: string;
  constructor(private opts: { url: string; model: string }) {
    this.name = `ollama/${opts.model}`;
  }

  async chat(system: string, user: string, maxTokens: number): Promise<string> {
    const res = await fetch(`${this.opts.url}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: this.opts.model,
        stream: false,
        options: { temperature: 0.2, num_predict: maxTokens },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { message: { content: string } };
    return json.message.content;
  }
}

/** Any OpenAI-compatible `/chat/completions`: OpenAI, OpenRouter, LM Studio, vLLM, Ollama's /v1. */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly name: string;
  constructor(private opts: { baseUrl: string; model: string; apiKey?: string }) {
    this.name = `openai/${opts.model}`;
  }

  async chat(system: string, user: string, maxTokens: number): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message.content ?? '';
  }
}

/** Models registered in VS Code (Copilot, or any Language Model Chat Provider extension). */
export class VscodeLmProvider implements ChatProvider {
  readonly name: string;
  constructor(private opts: { vendor?: string; family?: string }) {
    this.name = `vscode-lm/${opts.family ?? opts.vendor ?? 'any'}`;
  }

  async chat(system: string, user: string, maxTokens: number): Promise<string> {
    const [model] = await vscode.lm.selectChatModels({
      ...(this.opts.vendor ? { vendor: this.opts.vendor } : {}),
      ...(this.opts.family ? { family: this.opts.family } : {}),
    });
    if (!model) throw new Error(`no VS Code language model matches ${this.name} (is Copilot signed in?)`);
    const res = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(`${system}\n\n---\n\n${user}`)],
      { modelOptions: { max_tokens: maxTokens, temperature: 0.2 } },
      new vscode.CancellationTokenSource().token,
    );
    let out = '';
    for await (const chunk of res.text) out += chunk;
    return out;
  }
}

// Flags that skip Claude Code's session bootstrap (MCP servers, hooks) — the login still applies.
const CLAUDE_SLIM = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--tools', ''];

function run(bin: string, args: string[], stdin?: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${(err || out).slice(0, 200)}`))));
    child.stdin.end(stdin ?? '');
  });
}

/** The Claude Code CLI, one process per call: reuses the user's login (subscription or key). ~7–10 s. */
export class ClaudeCliProvider implements ChatProvider {
  readonly name: string;
  readonly slow = true;
  constructor(private opts: { model?: string; bin?: string; extraArgs?: string[] }) {
    this.name = `claude-cli/${opts.model || 'default'}`;
  }

  chat(system: string, user: string): Promise<string> {
    const args = ['-p', '--output-format', 'text', '--system-prompt', system, ...CLAUDE_SLIM, ...(this.opts.extraArgs ?? [])];
    if (this.opts.model) args.push('--model', this.opts.model);
    return run(this.opts.bin || 'claude', args, user);
  }
}

/** A single long-lived `claude -p --input-format stream-json` process; one turn at a time. */
class ClaudeSession {
  private child?: ReturnType<typeof spawn>;
  private turns = 0;
  private pending?: { resolve: (s: string) => void; reject: (e: Error) => void };
  private buf = '';
  busy = 0;

  constructor(private opts: { model?: string; bin?: string; maxTurns?: number; extraArgs?: string[] }) {}

  async turn(content: string): Promise<string> {
    this.busy++;
    try {
      if (!this.child || this.turns >= (this.opts.maxTurns ?? 30)) this.respawn();
      this.turns++;
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => this.fail(new Error('claude session: no answer after 120 s')), 120_000);
        this.pending = {
          resolve: (s) => (clearTimeout(timer), resolve(s)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        };
        this.child!.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      });
    } finally {
      this.busy--;
    }
  }

  private respawn() {
    this.child?.kill();
    this.turns = 0;
    this.buf = '';
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...CLAUDE_SLIM,
      '--system-prompt', 'Each user message is an independent task with its own instructions. Answer only the latest one, follow its format exactly, no preamble.',
      ...(this.opts.extraArgs ?? [])];
    if (this.opts.model) args.push('--model', this.opts.model);
    const child = spawn(this.opts.bin || 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout!.on('data', (d) => this.onData(String(d)));
    let err = '';
    child.stderr!.on('data', (d) => (err += d));
    child.on('error', (e) => this.fail(e));
    child.on('close', (code) => {
      if (this.child === child) this.child = undefined;
      this.fail(new Error(`claude session exited ${code}: ${err.slice(0, 200)}`));
    });
  }

  private onData(chunk: string) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: { type: string; result?: string; is_error?: boolean };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type !== 'result') continue;
      const p = this.pending;
      this.pending = undefined;
      if (!p) continue;
      msg.is_error ? p.reject(new Error(msg.result ?? 'claude session error')) : p.resolve(msg.result ?? '');
    }
  }

  private fail(e: Error) {
    const p = this.pending;
    this.pending = undefined;
    p?.reject(e);
  }

  dispose() {
    this.child?.kill();
    this.child = undefined;
  }
}

/**
 * A pool of persistent Claude sessions: the bootstrap is paid once per session, calls run in
 * parallel across sessions (least-busy first) and queue within one. ~4–7 s per call.
 */
export class ClaudeSessionProvider implements ChatProvider {
  readonly name: string;
  readonly slow = true;
  private sessions: ClaudeSession[];
  private queues: Promise<unknown>[];

  constructor(opts: { model?: string; bin?: string; maxTurns?: number; extraArgs?: string[]; size?: number }) {
    this.name = `claude-session/${opts.model || 'default'}`;
    const size = Math.max(1, opts.size ?? 3);
    this.sessions = Array.from({ length: size }, () => new ClaudeSession(opts));
    this.queues = this.sessions.map(() => Promise.resolve());
  }

  chat(system: string, user: string): Promise<string> {
    // Each turn carries its own instructions; the session system prompt only enforces independence.
    const content = `Instructions for this task:\n${system}\n\n---\n\n${user}`;
    let i = 0;
    for (let k = 1; k < this.sessions.length; k++) if (this.sessions[k].busy < this.sessions[i].busy) i = k;
    this.sessions[i].busy++; // reserve before the queue drains so the next caller sees it
    const next = this.queues[i].then(() => this.sessions[i].turn(content)).finally(() => this.sessions[i].busy--);
    this.queues[i] = next.catch(() => undefined);
    return next;
  }

  dispose() {
    for (const s of this.sessions) s.dispose();
  }
}

/** Cursor's Agent CLI (`agent -p`): reuses the Cursor subscription. Needs `agent login` once. */
export class CursorCliProvider implements ChatProvider {
  readonly name: string;
  readonly slow = true;
  constructor(private opts: { model?: string; bin?: string; workspace?: string; extraArgs?: string[] }) {
    this.name = `cursor-cli/${opts.model || 'default'}`;
  }

  chat(system: string, user: string): Promise<string> {
    // No system-prompt flag: fold the instructions into the prompt. `--trust` skips the workspace prompt.
    const args = ['-p', '--output-format', 'text', '--trust', ...(this.opts.extraArgs ?? [])];
    if (this.opts.workspace) args.push('--workspace', this.opts.workspace);
    if (this.opts.model) args.push('--model', this.opts.model);
    args.push(`${system}\n\n---\n\n${user}`);
    return run(this.opts.bin || 'agent', args, undefined, this.opts.workspace);
  }
}

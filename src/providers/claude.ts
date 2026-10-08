import { spawn } from 'child_process';
import { run } from './cli';
import { ChatProvider } from './types';

// Flags that skip Claude Code's session bootstrap (MCP servers, hooks) — the login still applies.
const CLAUDE_SLIM = ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--tools', ''];

/**
 * Environment for the claude process. With `subscription`, API-key variables are removed so the
 * CLI can only use the Claude Code login (Pro/Max usage), never a per-token billed key.
 */
function claudeEnv(auth: 'subscription' | 'inherit' | undefined): NodeJS.ProcessEnv {
  if (auth === 'inherit') return process.env;
  const env = { ...process.env };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']) delete env[k];
  return env;
}

const NOT_LOGGED_IN = /not logged in|please run \/login|authentication/i;
function loginHint(msg: string): string {
  return NOT_LOGGED_IN.test(msg) ? `${msg} — open a terminal, run \`claude\` and type /login (subscription), then retry` : msg;
}

/** The Claude Code CLI, one process per call: reuses the user's login (subscription or key). ~7–10 s. */
export class ClaudeCliProvider implements ChatProvider {
  readonly name: string;
  readonly slow = true;
  constructor(private opts: { model?: string; bin?: string; extraArgs?: string[]; auth?: 'subscription' | 'inherit' }) {
    this.name = `claude-cli/${opts.model || 'default'}`;
  }

  chat(system: string, user: string): Promise<string> {
    const args = ['-p', '--output-format', 'text', '--system-prompt', system, ...CLAUDE_SLIM, ...(this.opts.extraArgs ?? [])];
    if (this.opts.model) args.push('--model', this.opts.model);
    return run(this.opts.bin || 'claude', args, { stdin: user, env: claudeEnv(this.opts.auth), hint: loginHint });
  }
}

/** A single long-lived `claude -p --input-format stream-json` process; one turn at a time. */
class ClaudeSession {
  private child?: ReturnType<typeof spawn>;
  private turns = 0;
  private pending?: { resolve: (s: string) => void; reject: (e: Error) => void };
  private buf = '';
  busy = 0;

  constructor(private opts: { model?: string; bin?: string; maxTurns?: number; extraArgs?: string[]; auth?: 'subscription' | 'inherit' }) {}

  async turn(content: string): Promise<string> {
    this.busy++;
    try {
      if (!this.child || this.turns >= (this.opts.maxTurns ?? 30)) this.respawn();
      this.turns++;
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          // A late answer must never reach the next caller: the process goes with the turn.
          this.child?.kill();
          this.child = undefined;
          this.fail(new Error('claude session: no answer after 120 s'));
        }, 120_000);
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
    const child = spawn(this.opts.bin || 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: claudeEnv(this.opts.auth) });
    this.child = child;
    child.stdout!.on('data', (d) => {
      if (this.child === child) this.onData(String(d));
    });
    child.stdin!.on('error', () => undefined); // EPIPE when the process dies mid-write: reported by 'close\'
    let err = '';
    child.stderr!.on('data', (d) => (err += d));
    child.on('error', (e) => this.fail(e));
    child.on('close', (code) => {
      if (this.child !== child) return; // a process we replaced on purpose (recycle, timeout)
      this.child = undefined;
      this.fail(new Error(loginHint(`claude session exited ${code}: ${err.slice(0, 200)}`)));
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
      msg.is_error ? p.reject(new Error(loginHint(msg.result ?? 'claude session error'))) : p.resolve(msg.result ?? '');
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

  constructor(opts: { model?: string; bin?: string; maxTurns?: number; extraArgs?: string[]; size?: number; auth?: 'subscription' | 'inherit' }) {
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

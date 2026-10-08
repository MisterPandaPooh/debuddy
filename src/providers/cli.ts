import { spawn } from 'child_process';

export interface RunOptions {
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Rewrites the error message, e.g. to add a login hint. */
  hint?: (msg: string) => string;
  /** Kill the process after this many ms (default 120 s). */
  timeoutMs?: number;
}

/** Run a CLI to completion and return its stdout; a non-zero exit becomes an Error. */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: opts.cwd, env: opts.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => {
      err += `\nkilled after ${opts.timeoutMs ?? 120_000} ms`;
      child.kill();
    }, opts.timeoutMs ?? 120_000);
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const msg = `${bin} exited ${code}: ${(err || out).slice(0, 200)}`;
      reject(new Error(opts.hint ? opts.hint(msg) : msg));
    });
    child.stdin.on('error', () => undefined); // EPIPE on a fast exit is reported through 'close'
    child.stdin.end(opts.stdin ?? '');
  });
}

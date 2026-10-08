import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from './cli';
import { ChatProvider } from './types';

const CANDIDATES = ['agent', 'cursor-agent'];
let resolved: string | undefined;

/**
 * Cursor ships its CLI as `cursor-agent` and, depending on the version, links it as `agent`.
 * Honour an explicit setting, else take the first candidate found on PATH or in ~/.local/bin.
 */
export function resolveCursorBin(configured?: string): string {
  if (configured) return configured;
  if (resolved) return resolved;
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')];
  for (const name of CANDIDATES) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext);
        try {
          fs.accessSync(p, fs.constants.X_OK);
          return (resolved = p);
        } catch {
          /* next */
        }
      }
    }
  }
  throw new Error('Cursor Agent CLI not found (looked for `agent` and `cursor-agent` on PATH and in ~/.local/bin). Install it from Cursor (Cmd+Shift+P → "Install cursor-agent") or set explain.cursor.bin.');
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
    // `--mode ask` is read-only: the agent can neither edit files nor run commands from our prompt.
    const args = ['-p', '--output-format', 'text', '--mode', 'ask', '--trust', ...(this.opts.extraArgs ?? [])];
    if (this.opts.workspace) args.push('--workspace', this.opts.workspace);
    // Tolerate "--model x" pasted into the setting.
    const model = this.opts.model?.replace(/^--model\s+/, '').trim();
    if (model) args.push('--model', model);
    args.push(`${system}\n\n---\n\n${user}`);
    return run(resolveCursorBin(this.opts.bin), args, { cwd: this.opts.workspace });
  }
}

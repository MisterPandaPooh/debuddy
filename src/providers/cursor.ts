import { run } from './cli';
import { ChatProvider } from './types';

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
    return run(this.opts.bin || 'agent', args, { cwd: this.opts.workspace });
  }
}

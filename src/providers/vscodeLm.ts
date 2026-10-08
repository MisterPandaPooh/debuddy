import * as vscode from 'vscode';
import { ChatProvider } from './types';

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

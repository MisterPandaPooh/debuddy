import { spawn } from 'child_process';
import * as vscode from 'vscode';

/** One chat completion. Every provider reduces to this; the prompts live in explain.ts. */
export interface ChatProvider {
  readonly name: string;
  chat(system: string, user: string, maxTokens: number): Promise<string>;
}

export type ProviderKind = 'ollama' | 'openai' | 'vscode-lm' | 'claude-cli';

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

/** The Claude Code CLI in headless mode: reuses the user's login, no key to manage. */
export class ClaudeCliProvider implements ChatProvider {
  readonly name: string;
  constructor(private opts: { model?: string; bin?: string }) {
    this.name = `claude-cli/${opts.model ?? 'default'}`;
  }

  chat(system: string, user: string, _maxTokens: number): Promise<string> {
    const args = ['-p', '--output-format', 'text', '--system-prompt', system];
    if (this.opts.model) args.push('--model', this.opts.model);
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.bin ?? 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 200)}`))));
      child.stdin.end(user);
    });
  }
}

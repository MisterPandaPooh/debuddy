import * as vscode from 'vscode';
import { ClaudeCliProvider, ClaudeSessionProvider } from './claude';
import { CursorCliProvider } from './cursor';
import { DEFAULT_EMBEDDED, EmbeddedProvider } from './embedded';
import { OllamaProvider } from './ollama';
import { OpenAICompatibleProvider } from './openai';
import { ChatProvider, ProviderKind } from './types';
import { VscodeLmProvider } from './vscodeLm';

/** Builds providers from `explain.*` settings on demand, so a settings change applies to the next call. */
export class ProviderRegistry implements vscode.Disposable {
  private apiKey?: string;
  /** The persistent Claude session is kept across calls, keyed by its settings. */
  private session?: { key: string; provider: ClaudeSessionProvider };

  /** The in-process llama.cpp model is expensive to load: kept across calls, keyed by its settings. */
  private embedded?: { key: string; provider: EmbeddedProvider };

  constructor(private secrets: vscode.SecretStorage, private storageDir: string) {
    void secrets.get('explain.openai.apiKey').then((k) => (this.apiKey = k));
  }

  async setApiKey(key: string) {
    this.apiKey = key || undefined;
    if (key) await this.secrets.store('explain.openai.apiKey', key);
    else await this.secrets.delete('explain.openai.apiKey');
  }

  current(): ChatProvider {
    const c = vscode.workspace.getConfiguration('explain');
    switch (c.get<ProviderKind>('provider', 'embedded')) {
      case 'embedded': {
        const id = c.get<string>('embedded.model', DEFAULT_EMBEDDED);
        // One sequence per background call, plus one kept free for the statement on screen.
        const sequences = Math.max(1, c.get<number>('prefetch.parallel', 2)) + 1;
        const key = `${id}|${sequences}`;
        if (this.embedded?.key !== key) {
          this.embedded?.provider.dispose();
          this.embedded = { key, provider: new EmbeddedProvider(this.storageDir, id, sequences) };
        }
        return this.embedded.provider;
      }
      case 'openai':
        return new OpenAICompatibleProvider({
          baseUrl: c.get<string>('openai.baseUrl', 'https://openrouter.ai/api/v1'),
          model: c.get<string>('openai.model', 'anthropic/claude-haiku-4.5'),
          apiKey: this.apiKey,
        });
      case 'vscode-lm':
        return new VscodeLmProvider({ vendor: c.get<string>('vscodeLm.vendor') || undefined, family: c.get<string>('vscodeLm.family') || undefined });
      case 'claude-cli': {
        const effort = c.get<string>('claude.effort', 'low');
        const opts = {
          model: c.get<string>('claude.model') || undefined,
          bin: c.get<string>('claude.bin') || undefined,
          extraArgs: [...(effort ? ['--effort', effort] : []), ...c.get<string[]>('claude.extraArgs', [])],
          size: c.get<number>('claude.sessions', 3),
          auth: c.get<'subscription' | 'inherit'>('claude.auth', 'subscription'),
          settingSources: c.get<string>('claude.settingSources', ''),
        };
        if (!c.get<boolean>('claude.persistentSession', true)) return new ClaudeCliProvider(opts);
        const key = JSON.stringify(opts);
        if (this.session?.key !== key) {
          this.session?.provider.dispose();
          this.session = { key, provider: new ClaudeSessionProvider(opts) };
        }
        return this.session.provider;
      }
      case 'cursor-cli':
        return new CursorCliProvider({
          model: c.get<string>('cursor.model') || undefined,
          bin: c.get<string>('cursor.bin') || undefined,
          workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          extraArgs: c.get<string[]>('cursor.extraArgs', []),
        });
      default:
        return new OllamaProvider({ url: c.get<string>('ollamaUrl', 'http://localhost:11434'), model: c.get<string>('model', 'qwen2.5-coder:3b') });
    }
  }

  dispose() {
    this.session?.provider.dispose();
    this.embedded?.provider.dispose();
  }
}

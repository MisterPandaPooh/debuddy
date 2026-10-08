import * as vscode from 'vscode';
import { ExplainSession } from './adapter';
import { PromptExplainer } from './explain';
import { ChatProvider, ClaudeCliProvider, ClaudeSessionProvider, CursorCliProvider, OllamaProvider, OpenAICompatibleProvider, ProviderKind, VscodeLmProvider } from './providers';
import { SettingsUi } from './settingsUi';
import { TestIndex } from './tests';
import { ExplainUi } from './ui';

export function activate(context: vscode.ExtensionContext) {
  const ui = new ExplainUi();
  const registry = new ProviderRegistry(context.secrets);
  context.subscriptions.push(registry);
  const src = {
    explainer: new PromptExplainer(
      () => registry.current(),
      () => vscode.workspace.getConfiguration('explain').get<boolean>('exampleValues', true),
      () => vscode.workspace.getConfiguration('explain').get<string>('language', 'English'),
    ),
    tests: new TestIndex(),
    slow: () => registry.current().slow === true,
  };

  // Own context key for menus/keybindings: set while an Explain session is the active one.
  const setActive = (on: boolean) => vscode.commands.executeCommand('setContext', 'explain.active', on);
  void setActive(vscode.debug.activeDebugSession?.type === 'explain');

  const settingsUi = new SettingsUi();
  context.subscriptions.push(
    ui,
    settingsUi,
    vscode.commands.registerCommand('explain.configure', () => settingsUi.configure()),
    vscode.debug.onDidChangeActiveDebugSession((s) => setActive(s?.type === 'explain')),
    vscode.debug.onDidTerminateDebugSession(() => setActive(vscode.debug.activeDebugSession?.type === 'explain')),
    vscode.debug.registerDebugAdapterDescriptorFactory('explain', {
      createDebugAdapterDescriptor: () => {
        const session = new ExplainSession(ui, src);
        const sub = vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('explain') && session.invalidate());
        context.subscriptions.push(sub);
        return new vscode.DebugAdapterInlineImplementation(session);
      },
    }),
    // Lets a bare `{ "type": "explain" }` launch config start from the cursor.
    vscode.debug.registerDebugConfigurationProvider('explain', {
      resolveDebugConfiguration(_folder, config) {
        const editor = vscode.window.activeTextEditor;
        if (!config.type && editor) config = { type: 'explain', request: 'launch', name: 'Explain Mode' };
        if (!config.file && editor) {
          config.file = editor.document.uri.fsPath;
          config.line = editor.selection.active.line + 1;
        }
        return config.file ? config : undefined;
      },
    }),
    // Shows "Explain Mode: Start Here" in the F5 / Run and Debug picker, even with no launch.json.
    vscode.debug.registerDebugConfigurationProvider(
      'explain',
      {
        provideDebugConfigurations: () => [
          { type: 'explain', request: 'launch', name: 'Explain Mode: Start Here' },
        ],
      },
      vscode.DebugConfigurationProviderTriggerKind.Dynamic,
    ),
    vscode.commands.registerCommand('explain.autoWalk', async () => {
      const session = vscode.debug.activeDebugSession;
      if (session?.type !== 'explain') {
        void vscode.window.showInformationMessage('Start Explain Mode first (Cmd+Alt+E), then auto-walk.');
        return;
      }
      try {
        await session.customRequest('autoWalk');
      } catch (err) {
        void vscode.window.showErrorMessage(`Auto-walk failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    vscode.commands.registerCommand('explain.followThrow', async () => {
      const session = vscode.debug.activeDebugSession;
      if (session?.type !== 'explain') return;
      try {
        await session.customRequest('followThrow');
      } catch (err) {
        void vscode.window.showErrorMessage(`Follow throw failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    vscode.commands.registerCommand('explain.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'API key for the OpenAI-compatible provider (stored in VS Code secret storage, never in settings)',
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      await registry.setApiKey(key);
      void vscode.window.showInformationMessage(key ? 'Explain Mode: API key saved.' : 'Explain Mode: API key cleared.');
    }),
    vscode.commands.registerCommand('explain.startHere', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      return vscode.debug.startDebugging(folder, {
        type: 'explain',
        request: 'launch',
        name: 'Explain Mode',
        file: editor.document.uri.fsPath,
        line: editor.selection.active.line + 1,
      });
    }),
  );
}

/** Builds providers from `explain.*` settings on demand, so a settings change applies to the next call. */
class ProviderRegistry implements vscode.Disposable {
  private apiKey?: string;
  /** The persistent Claude session is kept across calls, keyed by its settings. */
  private session?: { key: string; provider: ClaudeSessionProvider };

  constructor(private secrets: vscode.SecretStorage) {
    void secrets.get('explain.openai.apiKey').then((k) => (this.apiKey = k));
  }

  async setApiKey(key: string) {
    this.apiKey = key || undefined;
    if (key) await this.secrets.store('explain.openai.apiKey', key);
    else await this.secrets.delete('explain.openai.apiKey');
  }

  current(): ChatProvider {
    const c = vscode.workspace.getConfiguration('explain');
    switch (c.get<ProviderKind>('provider', 'ollama')) {
      case 'openai':
        return new OpenAICompatibleProvider({
          baseUrl: c.get<string>('openai.baseUrl', 'https://openrouter.ai/api/v1'),
          model: c.get<string>('openai.model', 'anthropic/claude-haiku-4.5'),
          apiKey: this.apiKey,
        });
      case 'vscode-lm':
        return new VscodeLmProvider({ vendor: c.get<string>('vscodeLm.vendor') || undefined, family: c.get<string>('vscodeLm.family') || undefined });
      case 'claude-cli': {
        const effort = c.get<string>('claude.effort', '');
        const opts = {
          model: c.get<string>('claude.model') || undefined,
          bin: c.get<string>('claude.bin') || undefined,
          extraArgs: [...(effort ? ['--effort', effort] : []), ...c.get<string[]>('claude.extraArgs', [])],
          size: c.get<number>('claude.sessions', 3),
          auth: c.get<'subscription' | 'inherit'>('claude.auth', 'subscription'),
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
  }
}

export function deactivate() {}

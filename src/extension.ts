import * as vscode from 'vscode';
import { errMsg } from './util';
import { ExplainSession } from './adapter';
import { initLanguages, supportedLanguageIds } from './lang';
import { PromptExplainer } from './explain';
import { ProviderRegistry } from './providers/registry';
import { SettingsUi } from './settingsUi';
import { TestIndex } from './tests';
import { ExplainUi } from './ui';

/** What the loader calls each provider (by the first segment of its name). */
const PROVIDER_LABEL: Record<string, string> = {
  embedded: 'the local model',
  ollama: 'Ollama',
  'claude-session': 'Claude Code',
  'claude-cli': 'Claude Code',
  'cursor-cli': 'Cursor',
  openai: 'the API',
  'vscode-lm': 'Copilot',
};

export function activate(context: vscode.ExtensionContext) {
  initLanguages(context.extensionPath);
  const ui = new ExplainUi();
  const registry = new ProviderRegistry(context.secrets, context.globalStorageUri.fsPath);
  context.subscriptions.push(registry);
  const src = {
    explainer: new PromptExplainer(
      () => registry.current(),
      () => vscode.workspace.getConfiguration('explain').get<boolean>('exampleValues', true),
      () => vscode.workspace.getConfiguration('explain').get<string>('language', 'English'),
    ),
    tests: new TestIndex(),
    slow: () => registry.current().slow === true,
    providerName: () => {
      const kind = registry.current().name.split('/')[0];
      return PROVIDER_LABEL[kind] ?? kind;
    },
  };

  // Own context key for menus/keybindings: set while an Explain session is the active one.
  const setActive = (on: boolean) => vscode.commands.executeCommand('setContext', 'explain.active', on);
  void setActive(vscode.debug.activeDebugSession?.type === 'explain');

  const settingsUi = new SettingsUi(context.globalStorageUri.fsPath);
  const sessions = new Set<ExplainSession>();
  // Optional: load the model as soon as a supported file is open, so the first session starts instantly.
  let preloaded = false;
  const preload = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (preloaded || !doc || !vscode.workspace.getConfiguration('explain').get<boolean>('preload', false)) return;
    if (!supportedLanguageIds.includes(doc.languageId)) return;
    preloaded = true;
    void src.explainer.warmUp({ quiet: true }).catch(() => (preloaded = false));
  };
  preload();

  context.subscriptions.push(
    ui,
    settingsUi,
    vscode.window.onDidChangeActiveTextEditor(preload),
    vscode.commands.registerCommand('explain.configure', () => settingsUi.configure()),
    vscode.debug.onDidChangeActiveDebugSession((s) => setActive(s?.type === 'explain')),
    vscode.debug.onDidTerminateDebugSession(() => setActive(vscode.debug.activeDebugSession?.type === 'explain')),
    vscode.debug.registerDebugAdapterDescriptorFactory('explain', {
      createDebugAdapterDescriptor: () => {
        const session: ExplainSession = new ExplainSession(ui, src, () => sessions.delete(session));
        sessions.add(session);
        return new vscode.DebugAdapterInlineImplementation(session);
      },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('explain')) for (const s of sessions) s.invalidate();
    }),
    // Lets a bare `{ "type": "explain" }` launch config start from the cursor.
    vscode.debug.registerDebugConfigurationProvider('explain', {
      resolveDebugConfiguration(_folder, config) {
        const editor = vscode.window.activeTextEditor;
        if (!config.type && editor) config = { type: 'explain', request: 'launch', name: 'DeBuddy' };
        if (!config.file && editor) {
          config.file = editor.document.uri.fsPath;
          config.line = editor.selection.active.line + 1;
        }
        return config.file ? config : undefined;
      },
    }),
    // Shows "DeBuddy: Start Here" in the F5 / Run and Debug picker, even with no launch.json.
    vscode.debug.registerDebugConfigurationProvider(
      'explain',
      {
        provideDebugConfigurations: () => [
          { type: 'explain', request: 'launch', name: 'DeBuddy: Start Here' },
        ],
      },
      vscode.DebugConfigurationProviderTriggerKind.Dynamic,
    ),
    vscode.commands.registerCommand('explain.autoWalk', async () => {
      const session = vscode.debug.activeDebugSession;
      if (session?.type !== 'explain') {
        void vscode.window.showInformationMessage('Start DeBuddy first (Cmd+Alt+E), then auto-walk.');
        return;
      }
      try {
        await session.customRequest('autoWalk');
      } catch (err) {
        void vscode.window.showErrorMessage(`Auto-walk failed: ${errMsg(err)}`);
      }
    }),
    vscode.commands.registerCommand('explain.followThrow', async () => {
      const session = vscode.debug.activeDebugSession;
      if (session?.type !== 'explain') return;
      try {
        await session.customRequest('followThrow');
      } catch (err) {
        void vscode.window.showErrorMessage(`Follow throw failed: ${errMsg(err)}`);
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
      void vscode.window.showInformationMessage(key ? 'DeBuddy: API key saved.' : 'DeBuddy: API key cleared.');
    }),
    vscode.commands.registerCommand('explain.startHere', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
      return vscode.debug.startDebugging(folder, {
        type: 'explain',
        request: 'launch',
        name: 'DeBuddy',
        file: editor.document.uri.fsPath,
        line: editor.selection.active.line + 1,
      });
    }),
  );
}

export function deactivate() {}

import * as vscode from 'vscode';
import { ExplainSession } from './adapter';
import { PromptExplainer } from './explain';
import { ProviderRegistry } from './providers/registry';
import { SettingsUi } from './settingsUi';
import { TestIndex } from './tests';
import { ExplainUi } from './ui';

export function activate(context: vscode.ExtensionContext) {
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
  };

  // Own context key for menus/keybindings: set while an Explain session is the active one.
  const setActive = (on: boolean) => vscode.commands.executeCommand('setContext', 'explain.active', on);
  void setActive(vscode.debug.activeDebugSession?.type === 'explain');

  const settingsUi = new SettingsUi(context.globalStorageUri.fsPath);
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

export function deactivate() {}

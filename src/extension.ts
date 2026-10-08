import * as vscode from 'vscode';
import { ExplainSession } from './adapter';
import { OllamaExplainer } from './explain';
import { TestIndex } from './tests';
import { ExplainUi } from './ui';

export function activate(context: vscode.ExtensionContext) {
  const ui = new ExplainUi();
  const src = { explainer: new OllamaExplainer(), tests: new TestIndex() };

  // Own context key for menus/keybindings: set while an Explain session is the active one.
  const setActive = (on: boolean) => vscode.commands.executeCommand('setContext', 'explain.active', on);
  void setActive(vscode.debug.activeDebugSession?.type === 'explain');

  context.subscriptions.push(
    ui,
    vscode.debug.onDidChangeActiveDebugSession((s) => setActive(s?.type === 'explain')),
    vscode.debug.onDidTerminateDebugSession(() => setActive(vscode.debug.activeDebugSession?.type === 'explain')),
    vscode.debug.registerDebugAdapterDescriptorFactory('explain', {
      createDebugAdapterDescriptor: () =>
        new vscode.DebugAdapterInlineImplementation(new ExplainSession(ui, src)),
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

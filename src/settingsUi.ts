import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { ProviderKind } from './providers';

// Measured in bench/RESULTS.md: above ~2 GB latency grows faster than accuracy with this prompt.
const OLLAMA_TIERS = [
  { id: 'qwen2.5-coder:0.5b', detail: '0.4 GB · ~0.2 s/line · minimum: correct but shallow' },
  { id: 'qwen2.5-coder:3b', detail: '1.9 GB · ~0.4 s/line · default, best balance' },
  { id: 'llama3.2:3b', detail: '2.0 GB · ~0.45 s/line · alternative to the default' },
  { id: 'qwen2.5-coder:7b', detail: '4.7 GB · ~0.9 s/line · slightly deeper, twice slower' },
  { id: 'qwen2.5:14b-instruct-q4_K_M', detail: '9 GB · ~2 s/line · max; no visible gain over 7B here' },
];

const KINDS: { provider: ProviderKind; label: string; detail: string }[] = [
  { provider: 'ollama', label: 'Ollama (local)', detail: 'free, ~0.4 s per step with qwen2.5-coder:3b' },
  { provider: 'claude-cli', label: 'Claude Code CLI', detail: 'your Claude login (subscription), ~4 s per call with the persistent session' },
  { provider: 'cursor-cli', label: 'Cursor Agent CLI', detail: 'your Cursor subscription; run `agent login` once' },
  { provider: 'vscode-lm', label: 'VS Code models (Copilot)', detail: 'needs Copilot; not available in Cursor' },
  { provider: 'openai', label: 'OpenAI-compatible API', detail: 'OpenRouter, OpenAI, LM Studio, vLLM — needs a key' },
];

/** Status bar entry + QuickPick to switch provider/model without opening the settings page. */
export class SettingsUi implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.item.command = 'explain.configure';
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('explain') && this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );
    this.refresh();
  }

  private refresh() {
    const lang = vscode.window.activeTextEditor?.document.languageId;
    if (!lang || !/typescript|javascript/.test(lang)) return this.item.hide();
    const c = vscode.workspace.getConfiguration('explain');
    const kind = c.get<ProviderKind>('provider', 'ollama');
    const model =
      kind === 'ollama' ? c.get<string>('model')
      : kind === 'claude-cli' ? c.get<string>('claude.model') || 'default'
      : kind === 'cursor-cli' ? c.get<string>('cursor.model') || 'default'
      : kind === 'vscode-lm' ? c.get<string>('vscodeLm.family') || 'first available'
      : c.get<string>('openai.model');
    this.item.text = `$(comment-discussion) Explain: ${kind} · ${model}`;
    this.item.tooltip = 'Explain Mode — click to change provider or model';
    this.item.show();
  }

  /** Two-step QuickPick: provider, then model (listed live where possible). */
  async configure() {
    const c = vscode.workspace.getConfiguration('explain');
    const current = c.get<ProviderKind>('provider', 'ollama');
    type Item = vscode.QuickPickItem & { provider?: ProviderKind };
    const items: Item[] = [
      ...KINDS.map((k) => ({ ...k, description: k.provider === current ? '$(check) current' : '' })),
      { label: '$(settings-gear) All Explain Mode settings…', detail: 'context window, definition depth, auto-walk dwell, …' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Explain Mode: which model explains your code?' });
    if (!pick) return;
    if (!pick.provider) return void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:netanelcs.explain-mode');
    await c.update('provider', pick.provider, vscode.ConfigurationTarget.Global);
    await this.pickModel(pick.provider);
  }

  private async pickModel(kind: ProviderKind) {
    const c = vscode.workspace.getConfiguration('explain');
    const set = (key: string, value: string) => c.update(key, value, vscode.ConfigurationTarget.Global);
    switch (kind) {
      case 'ollama': {
        const installed = await this.ollamaModels(c.get<string>('ollamaUrl', 'http://localhost:11434'));
        const has = (id: string) => installed.includes(id) || installed.includes(`${id}:latest`);
        type Item = vscode.QuickPickItem & { id?: string; pull?: boolean };
        const items: Item[] = [
          { label: 'Recommended (measured)', kind: vscode.QuickPickItemKind.Separator },
          ...OLLAMA_TIERS.map((t) => ({ label: t.id, detail: t.detail, description: has(t.id) ? '$(check) installed' : '$(cloud-download) will pull', id: t.id, pull: !has(t.id) })),
          { label: 'Installed', kind: vscode.QuickPickItemKind.Separator },
          ...installed.filter((m) => !OLLAMA_TIERS.some((t) => m === t.id || m === `${t.id}:latest`)).map((m) => ({ label: m, id: m })),
          { label: '$(edit) Other…' },
        ];
        const pick = await vscode.window.showQuickPick(items, { placeHolder: installed.length ? 'Ollama model' : 'Ollama is not reachable — pick a tier to pull, or type a name' });
        if (!pick) return;
        const name = pick.id ?? (await vscode.window.showInputBox({ prompt: 'Ollama model', value: c.get('model') }));
        if (!name) return;
        await set('model', name);
        if (pick.pull) {
          // The download runs where the user can see it; the setting already points at the model.
          const term = vscode.window.createTerminal('Explain Mode: ollama pull');
          term.show();
          term.sendText(`ollama pull ${name}`);
        }
        return;
      }
      case 'claude-cli': {
        const pick = await vscode.window.showQuickPick(['default', 'haiku', 'sonnet', 'opus'], { placeHolder: 'Claude model (--model)' });
        if (pick !== undefined) await set('claude.model', pick === 'default' ? '' : pick);
        return;
      }
      case 'cursor-cli': {
        // Effort is part of the model id at Cursor (-low / -high / -fast): picking the model picks the effort.
        const models = await this.cursorModels(c.get<string>('cursor.bin') || 'agent');
        if (!models.length) {
          void vscode.window.showWarningMessage('Cursor CLI returned no models — run `agent login` in a terminal first.');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          models.map((m) => ({ label: m.id, description: m.label })),
          { placeHolder: 'Cursor model (effort and speed are in the name)', matchOnDescription: true },
        );
        if (pick) await set('cursor.model', pick.label);
        return;
      }
      case 'vscode-lm': {
        let models: vscode.LanguageModelChat[] = [];
        try {
          models = await vscode.lm.selectChatModels();
        } catch {
          /* no lm API (Cursor) or nothing registered */
        }
        if (!models.length) return void vscode.window.showWarningMessage('No VS Code language model is available (sign in to Copilot, or pick another provider).');
        const pick = await vscode.window.showQuickPick(
          models.map((m) => ({ label: m.family, description: `${m.vendor} · ${m.name}` })),
          { placeHolder: 'Model family' },
        );
        if (pick) await set('vscodeLm.family', pick.label);
        return;
      }
      case 'openai': {
        const baseUrl = await vscode.window.showInputBox({ prompt: 'Base URL (…/v1)', value: c.get('openai.baseUrl') });
        if (baseUrl === undefined) return;
        await set('openai.baseUrl', baseUrl);
        const model = await vscode.window.showInputBox({ prompt: 'Model id', value: c.get('openai.model') });
        if (model === undefined) return;
        await set('openai.model', model);
        const key = await vscode.window.showQuickPick(['Set API key now', 'Keep the stored key'], { placeHolder: 'API key' });
        if (key === 'Set API key now') await vscode.commands.executeCommand('explain.setApiKey');
        return;
      }
    }
  }

  private cursorModels(bin: string): Promise<{ id: string; label: string }[]> {
    return new Promise((resolve) => {
      execFile(bin, ['--list-models'], { timeout: 20_000 }, (_err, stdout, stderr) => {
        const text = `${stdout}\n${stderr}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
        const out: { id: string; label: string }[] = [];
        for (const line of text.split('\n')) {
          const m = line.trim().match(/^([\w.:-]+)\s+-\s+(.+)$/);
          if (m) out.push({ id: m[1], label: m[2].trim() });
        }
        resolve(out);
      });
    });
  }

  private async ollamaModels(url: string): Promise<string[]> {
    try {
      const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const json = (await res.json()) as { models: { name: string }[] };
      return json.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  dispose() {
    this.item.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

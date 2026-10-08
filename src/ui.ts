import * as vscode from 'vscode';
import { errMsg } from './util';
import { ExampleValue, Explanation } from './explain';
import { supportedLanguageIds } from './lang';
import { Branch, Step } from './lang';

export interface ShowOptions {
  header?: string;
  footer?: string;
  /** Deterministic: errors the statement's callees can throw. Shown even if the model missed them. */
  throws?: string[];
  /** Deterministic: where a throw from this statement lands. */
  lands?: string;
}

/** Example values for the current statement, merged into the normal hover — the debug hover is
 * disabled because it would replace the language hover and error on non-variables. */
export class HoverValues implements vscode.HoverProvider {
  private uri?: string;
  private values: ExampleValue[] = [];
  private types = new Map<string, string>();

  set(uri: vscode.Uri, values: ExampleValue[], vars: string[]) {
    this.uri = uri.fsPath;
    this.values = values;
    this.types = new Map(vars.map((v) => [v.split(':')[0].trim(), v.slice(v.indexOf(':') + 1).trim()]));
  }

  clear() {
    this.uri = undefined;
    this.values = [];
    this.types.clear();
  }

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    if (doc.uri.fsPath !== this.uri) return undefined;
    const range = doc.getWordRangeAtPosition(pos, /[\w$]+/);
    if (!range) return undefined;
    const name = doc.getText(range);
    const v = this.values.find((x) => x.name === name);
    if (!v) return undefined;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Explain** — example value _(illustrative, not runtime)_\n\n`);
    md.appendCodeblock(`${name} = ${v.example}${v.alternative ? `   // or: ${v.alternative}` : ''}`, doc.languageId);
    return new vscode.Hover(md, range);
  }
}

/** Shows the explanation as a collapsible comment thread right under the current statement. */
export class ExplainUi implements vscode.Disposable {
  readonly hover = new HoverValues();
  private hoverReg = vscode.languages.registerHoverProvider(supportedLanguageIds, this.hover);
  private controller = vscode.comments.createCommentController('explain', 'Explain Mode');
  private thread?: vscode.CommentThread;
  private output = vscode.window.createOutputChannel('Explain Mode');
  // Same colour VS Code uses for the stopped line, since in auto mode the thread is "running".
  private running = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
  });
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  constructor() {
    this.controller.options = { placeHolder: '' };
  }

  log(msg: string) {
    this.output.appendLine(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  }

  showPending(uri: vscode.Uri, line: number, header?: string) {
    this.render(uri, line, `${header ? header + '\n\n' : ''}_Explaining…_`);
  }

  show(uri: vscode.Uri, line: number, e: Explanation, opts: ShowOptions = {}) {
    const md = [
      opts.header,
      `**Does** ${e.does}`,
      `**Why** ${e.why}`,
      e.watch ? `**Watch** ⚠️ ${e.watch}` : undefined,
      opts.throws?.length ? `**Throws** 🔥 ${opts.throws.join(', ')}${opts.lands ? ` — ${opts.lands}` : ''}` : undefined,
      opts.footer,
    ]
      .filter(Boolean)
      .join('\n\n');
    this.render(uri, line, md);
  }

  /** Highlight + reveal a line while auto-walking (no StoppedEvent, so VS Code draws nothing). */
  async highlight(uri: vscode.Uri, line: number) {
    const editor = await vscode.window.showTextDocument(uri, { preserveFocus: true, preview: false });
    const range = new vscode.Range(line - 1, 0, line - 1, 0);
    editor.setDecorations(this.running, [range]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  clearHighlight() {
    for (const e of vscode.window.visibleTextEditors) e.setDecorations(this.running, []);
  }

  setAutoStatus(on: boolean) {
    if (!on) return this.status.hide();
    this.status.text = '$(debug-pause) Explain: auto-walking';
    this.status.tooltip = 'Click or press F6 to pause';
    this.status.command = 'workbench.action.debug.pause';
    this.status.show();
  }

  /** Ask which side of an `if` to read; `undefined` means both, in source order. */
  async pickBranch(step: Step): Promise<Branch | undefined> {
    const items = [
      ...(step.branches ?? []).map((b) => ({ label: `$(arrow-right) ${b.label}`, description: `L${b.from}–${b.to}`, branch: b })),
      { label: '$(list-flat) both', description: 'read every branch in source order', branch: undefined },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `if (${step.text.trim()}) — which path do you want to follow?` });
    return pick?.branch;
  }

  /** Replace a placeholder in the current thread's body (e.g. a summary that arrived late). */
  patchHeader(placeholder: string, text: string) {
    const c = this.thread?.comments[0];
    if (!c || !this.thread) return;
    const body = typeof c.body === 'string' ? c.body : c.body.value;
    if (!body.includes(placeholder)) return;
    this.thread.comments = [{ ...c, body: new vscode.MarkdownString(body.replace(placeholder, () => text)) }];
  }

  showError(uri: vscode.Uri, line: number, err: unknown) {
    this.render(uri, line, `⚠️ ${errMsg(err)}`);
  }

  private render(uri: vscode.Uri, line: number, markdown: string) {
    this.thread?.dispose();
    const range = new vscode.Range(line - 1, 0, line - 1, 0);
    this.thread = this.controller.createCommentThread(uri, range, [
      {
        author: { name: 'Explain' },
        body: new vscode.MarkdownString(markdown),
        mode: vscode.CommentMode.Preview,
      },
    ]);
    this.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.thread.canReply = false;
  }

  clear() {
    this.thread?.dispose();
    this.thread = undefined;
    this.hover.clear();
  }

  dispose() {
    this.clear();
    this.clearHighlight();
    this.controller.dispose();
    this.hoverReg.dispose();
    this.output.dispose();
    this.running.dispose();
    this.status.dispose();
  }
}

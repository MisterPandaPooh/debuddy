import * as vscode from 'vscode';
import { Explanation } from './explain';

export interface ShowOptions {
  header?: string;
  footer?: string;
  /** Deterministic: errors the statement's callees can throw. Shown even if the model missed them. */
  throws?: string[];
}

/** Shows the explanation as a collapsible comment thread right under the current statement. */
export class ExplainUi implements vscode.Disposable {
  private controller = vscode.comments.createCommentController('explain', 'Explain Mode');
  private thread?: vscode.CommentThread;
  private output = vscode.window.createOutputChannel('Explain Mode');

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
      opts.throws?.length ? `**Throws** 🔥 ${opts.throws.join(', ')}` : undefined,
      opts.footer,
    ]
      .filter(Boolean)
      .join('\n\n');
    this.render(uri, line, md);
  }

  showError(uri: vscode.Uri, line: number, err: unknown) {
    this.render(uri, line, `⚠️ ${err instanceof Error ? err.message : String(err)}`);
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
  }

  dispose() {
    this.clear();
    this.controller.dispose();
    this.output.dispose();
  }
}

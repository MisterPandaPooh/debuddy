import * as vscode from 'vscode';
import { Explanation } from './explain';

/** Shows the explanation as a collapsible comment thread right under the current statement. */
export class ExplainUi implements vscode.Disposable {
  private controller = vscode.comments.createCommentController('explain', 'Explain Mode');
  private thread?: vscode.CommentThread;

  constructor() {
    this.controller.options = { placeHolder: '' };
  }

  showPending(uri: vscode.Uri, line: number, header?: string) {
    this.render(uri, line, `${header ? header + '\n\n' : ''}_Explaining…_`);
  }

  show(uri: vscode.Uri, line: number, e: Explanation, header?: string) {
    const md = [
      header,
      `**Does** ${e.does}`,
      `**Why** ${e.why}`,
      e.watch ? `**Watch** ⚠️ ${e.watch}` : undefined,
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
  }
}

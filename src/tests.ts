import * as vscode from 'vscode';

/**
 * Test titles are the best spec a repo has: human-written, in plain language, and true.
 * This finds `it(...)` / `test(...)` titles whose body mentions the function.
 */
export class TestIndex {
  private files?: Promise<vscode.Uri[]>;
  private texts = new Map<string, Promise<string>>();

  async titlesFor(fnName: string, limit = 6): Promise<string[]> {
    if (!fnName || fnName === '(anonymous)') return [];
    const needle = new RegExp(`\\b${fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const out: string[] = [];
    for (const uri of await this.specFiles()) {
      const text = await this.read(uri);
      if (!needle.test(text)) continue;
      out.push(...titlesMentioning(text, needle));
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  private specFiles(): Promise<vscode.Uri[]> {
    this.files ??= Promise.resolve(
      vscode.workspace.findFiles('**/*.{spec,test}.{ts,tsx,js,jsx,mts,cts}', '**/node_modules/**', 300),
    );
    return this.files;
  }

  private read(uri: vscode.Uri): Promise<string> {
    let p = this.texts.get(uri.fsPath);
    if (!p) {
      p = Promise.resolve(vscode.workspace.fs.readFile(uri)).then((b) => Buffer.from(b).toString('utf8'));
      this.texts.set(uri.fsPath, p);
    }
    return p;
  }
}

const TITLE = /\b(describe|it|test)\s*\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;

/** "describe › it" titles for every it/test block whose text (up to the next block) matches `needle`. */
export function titlesMentioning(text: string, needle: RegExp): string[] {
  const blocks: { kind: string; title: string; start: number }[] = [];
  for (const m of text.matchAll(TITLE)) blocks.push({ kind: m[1], title: m[3], start: m.index ?? 0 });
  const out: string[] = [];
  let describe = '';
  blocks.forEach((b, i) => {
    if (b.kind === 'describe') {
      describe = b.title;
      return;
    }
    const body = text.slice(b.start, blocks[i + 1]?.start ?? text.length);
    if (needle.test(body)) out.push(describe ? `${describe} › ${b.title}` : b.title);
  });
  return out;
}

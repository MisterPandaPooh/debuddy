// Minimal `vscode` for headless tests: documents, positions/ranges, no-op commands and UI.
const fs = require('fs');

class Position {
  constructor(line, character) { this.line = line; this.character = character; }
  translate(dl, dc) { return new Position(this.line + dl, this.character + dc); }
  isEqual(o) { return o.line === this.line && o.character === this.character; }
}
class Range {
  constructor(a, b, c, d) {
    // duck-typed: the bundle and the test may hold different copies of this module
    if (a && typeof a.line === 'number') { this.start = a; this.end = b; } else { this.start = new Position(a, b); this.end = new Position(c, d); }
  }
}
class Uri { constructor(p) { this.fsPath = p; } static file(p) { return new Uri(p); } }

const LANG = { ts: 'typescript', js: 'javascript', py: 'python', rs: 'rust', go: 'go' };

function openTextDocument(p) {
  const fsPath = typeof p === 'string' ? p : p.fsPath;
  const text = fs.readFileSync(fsPath, 'utf8');
  const lines = text.split('\n');
  const offsetAt = (q) => lines.slice(0, q.line).reduce((a, l) => a + l.length + 1, 0) + q.character;
  const positionAt = (o) => { const b = text.slice(0, o).split('\n'); return new Position(b.length - 1, b[b.length - 1].length); };
  return Promise.resolve({
    fileName: fsPath,
    languageId: LANG[fsPath.split('.').pop()] ?? 'plaintext',
    uri: new Uri(fsPath),
    lineCount: lines.length,
    getText: (r) => (r ? text.slice(offsetAt(r.start), offsetAt(r.end)) : text),
    positionAt,
    offsetAt,
    lineAt: (l) => {
      const t = lines[typeof l === 'number' ? l : l.line] ?? '';
      return { text: t, firstNonWhitespaceCharacterIndex: t.search(/\S|$/), isEmptyOrWhitespace: !t.trim() };
    },
  });
}

module.exports = {
  Position, Range, Uri, Location: class {},
  SymbolKind: { Function: 11, Method: 5, Constructor: 8 },
  ProgressLocation: { Notification: 15 },
  commands: { executeCommand: async () => [] },
  window: { setStatusBarMessage: () => ({ dispose() {} }), showErrorMessage: async () => undefined, showInformationMessage: async () => undefined },
  workspace: {
    getConfiguration: (section) => ({ get: (k, d) => {
      if (section === 'explain.auto' && k === 'enabled') return process.env.EXPLAIN_AUTO === '1';
      if (section === 'explain.auto' && k === 'dwellMs') return 20;
      if (section === 'explain' && k === 'askBranch') return false;
      return d;
    } }),
    openTextDocument,
    getWorkspaceFolder: () => ({}),
    findFiles: async () => [],
    fs: { readFile: async () => new Uint8Array() },
  },
};

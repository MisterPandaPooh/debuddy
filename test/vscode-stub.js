const fs = require('fs');
class Position { constructor(l, c) { this.line = l; this.character = c; } translate(dl, dc) { return new Position(this.line + dl, this.character + dc); } }
class Uri { constructor(p) { this.fsPath = p; } static file(p) { return new Uri(p); } }
function openTextDocument(p) {
  const fsPath = typeof p === 'string' ? p : p.fsPath;
  const text = fs.readFileSync(fsPath, 'utf8'); const lines = text.split('\n');
  return Promise.resolve({
    fileName: fsPath, languageId: 'typescript', uri: new Uri(fsPath), getText: () => text,
    positionAt: (o) => { const b = text.slice(0, o).split('\n'); return new Position(b.length - 1, b[b.length - 1].length); },
    offsetAt: (q) => lines.slice(0, q.line).reduce((a, l) => a + l.length + 1, 0) + q.character,
    lineAt: (l) => ({ firstNonWhitespaceCharacterIndex: lines[l].search(/\S|$/) }),
  });
}
module.exports = {
  Position, Uri, Range: class {}, Location: class {},
  commands: { executeCommand: async () => [] },
  workspace: { getConfiguration: (section) => ({ get: (k, d) => {
      if (section === 'explain.auto' && k === 'enabled') return process.env.EXPLAIN_AUTO === '1';
      if (section === 'explain.auto' && k === 'dwellMs') return 20;
      if (section === 'explain' && k === 'askBranch') return false;
      return d;
    } }), openTextDocument, getWorkspaceFolder: () => ({}), findFiles: async () => [], fs: { readFile: async () => new Uint8Array() } },
};

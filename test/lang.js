// Headless check of every walker: steps, branches, handlers and throws for one function per language.
// Usage: node test/lang.js   (after `esbuild src/lang/index.ts … --outfile=test/lang.bundle.js`)
const path = require('path');
const vscode = require('./vscode-stub.js');
const { frameAt, initLanguages } = require('./lang.bundle.js');

initLanguages(path.join(__dirname, '..'));

const cases = [
  ['sample/user.service.ts', 4],
  ['sample/order.service.ts', 14],
  ['sample/orders.py', 10],
  ['sample/orders.rs', 8],
];

(async () => {
  let failures = 0;
  for (const [file, line] of cases) {
    const doc = await vscode.workspace.openTextDocument(path.join(__dirname, '..', file));
    const frame = await frameAt(doc, line);
    console.log(`\n# ${file}:${line} → ${frame ? `${frame.name}() L${frame.startLine}, throws=[${frame.throws}]` : 'NO FRAME'}`);
    if (!frame) { failures++; continue; }
    for (const s of frame.steps) {
      const flags = [
        s.branches ? `branches=${s.branches.map((b) => `${b.label}:${b.from}-${b.to}`).join(',')}` : '',
        s.handler ? `handler=L${s.handler.line}` : '',
        s.throwsSelf ? `throws=${s.throwsSelf}` : '',
        s.mayThrow ? `may=${s.mayThrow}` : '',
        s.declared.length ? `decl=[${s.declared.map((d) => d.name)}]` : '',
      ].filter(Boolean).join(' ');
      console.log(`  L${String(s.line).padEnd(3)} ${s.text.split('\n')[0].slice(0, 44).padEnd(45)} calls=[${s.calls.map((c) => c.name)}] ${flags}`);
    }
  }
  process.exit(failures ? 1 : 0);
})();

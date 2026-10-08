// Headless check of every walker: steps, branches, handlers and throws for one function per language.
// Usage: node test/lang.js   (after `esbuild src/lang/index.ts … --outfile=test/lang.bundle.js`)
const path = require('path');
const vscode = require('./vscode-stub.js');
const { frameAt, initLanguages, resolveProjectCallee } = require('./lang.bundle.js');

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
        s.guard ? `guard=${s.guard}` : '',
        s.throwsSelf ? `throws=${s.throwsSelf}` : '',
        s.mayThrow ? `may=${s.mayThrow}` : '',
        s.declared.length ? `decl=[${s.declared.map((d) => d.name)}]` : '',
      ].filter(Boolean).join(' ');
      console.log(`  L${String(s.line).padEnd(3)} ${s.text.split('\n')[0].slice(0, 44).padEnd(45)} calls=[${s.calls.map((c) => c.name)}] ${flags}`);
    }
  }
  // Without a language server (the stub answers nothing), the walkers must still find same-file functions.
  for (const [file, line, callee] of [['sample/orders.py', 12, 'audit'], ['sample/orders.rs', 10, 'audit'], ['sample/order.service.ts', 16, 'audit']]) {
    const doc = await vscode.workspace.openTextDocument(path.join(__dirname, '..', file));
    const frame = await frameAt(doc, line);
    const call = frame.steps.find((s) => s.line === line)?.calls.find((c) => c.name === callee);
    const loc = call && (await resolveProjectCallee(doc.uri, call));
    console.log(`\n# findFunction ${file}:${line} ${callee} → ${loc ? `L${loc.range.start.line + 1}` : 'NOT FOUND'}`);
    if (!loc) failures++;
  }
  process.exit(failures ? 1 : 0);
})();

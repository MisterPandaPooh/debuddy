// Copies the tree-sitter runtime and the grammars the extension ships into dist/grammars.
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'dist', 'grammars');
fs.mkdirSync(out, { recursive: true });
const files = [
  'node_modules/web-tree-sitter/web-tree-sitter.wasm',
  'node_modules/tree-sitter-python/tree-sitter-python.wasm',
  'node_modules/tree-sitter-rust/tree-sitter-rust.wasm',
];
for (const f of files) {
  const src = path.join(__dirname, '..', f);
  fs.copyFileSync(src, path.join(out, path.basename(f)));
}
console.log(`grammars: ${files.length} files → dist/grammars`);

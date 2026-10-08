// Headless DAP harness: replays initialize → launch → setBreakpoints → continue against ExplainSession.
// Usage: node dap.js <file> <entryLine> <bpLine>
const fs = require('fs');
const [, , fileArg, entryArg, bpArg] = process.argv;
const file = require('path').resolve(fileArg ?? 'sample/user.service.ts');
const entryLine = entryArg ?? '11', bpLine = bpArg ?? '13';
const SCENARIO = process.env.EXPLAIN_SCENARIO ?? (process.env.EXPLAIN_AUTO === '1' ? 'auto-f5' : process.env.EXPLAIN_AUTO === '2' ? 'auto-button' : 'continue');
const { ExplainSession } = require('./adapter.bundle.js');

const explainer = {
  explainStatement: async (ctx) => ({ does: `[stub] ${ctx.statement.slice(0, 30)}`, why: '', watch: '' }),
  summarizeFunction: async () => '[stub summary]',
  exampleValues: async (ctx) => ctx.vars.map((v) => ({ name: v.split(':')[0], example: '{ …example }', alternative: 'null' })),
  answer: async (ctx, q) => `[stub answer to "${q}" about: ${ctx.statement.slice(0, 20)}]`,
};
const ui = {
  log: (m) => console.log('   log:', m),
  showPending: () => {}, show: (u, l, e, o) => console.log(`   ui.show L${l}`, e.does, o?.footer ?? ''), showError: (u, l, e) => console.log('   ui.error', e), clear: () => {},
  highlight: async (u, l) => console.log(`   ui.highlight L${l}`), clearHighlight: () => {}, setAutoStatus: () => {}, pickBranch: async () => undefined,
};

const session = new ExplainSession(ui, { explainer, tests: { titlesFor: async () => ['getRoles › returns [] when no doc'] } });
session.sendEvent = (e) => console.log(`   → event ${e.event}`, e.body ? JSON.stringify(e.body) : '');
session.sendResponse = (r) => console.log(`   → response ${r.command}`, r.body ? JSON.stringify(r.body).slice(0, 120) : '');
session.sendErrorResponse = (r, code, msg) => console.log(`   → ERROR ${r.command}: ${msg}`);

let seq = 0;
const send = (command, args = {}) => {
  console.log(`\n← ${command} ${JSON.stringify(args)}`);
  session.dispatchRequest({ seq: ++seq, type: 'request', command, arguments: args });
};
const tick = () => new Promise((r) => setTimeout(r, 50));

(async () => {
  send('initialize', { pathFormat: 'path' });
  send('launch', { file, line: Number(entryLine) });
  await tick();
  send('setBreakpoints', { source: { name: 'x', path: file }, breakpoints: [{ line: Number(bpLine) }] });
  send('configurationDone');
  await tick();
  if (SCENARIO === 'throw') { send('followThrow', {}); await tick(); send('stackTrace', { threadId: 1 }); return; }
  if (SCENARIO === 'next') { send('next', { threadId: 1 }); await tick(); send('stackTrace', { threadId: 1 }); return; }
  send('continue', { threadId: 1 });
  await tick();
  if (process.env.EXPLAIN_AUTO === '1') { await tick(); await tick(); send('pause', { threadId: 1 }); await tick(); }
  if (process.env.EXPLAIN_AUTO === '2') { send('autoWalk', {}); await tick(); await tick(); send('pause', { threadId: 1 }); await tick(); }

  send('stackTrace', { threadId: 1 });
  send('scopes', { frameId: 0 });
  send('variables', { variablesReference: 2 });
  send('evaluate', { expression: 'active', context: 'hover' });
  send('evaluate', { expression: 'why filter here?', context: 'repl' });
  await tick();
  send('stepBack', { threadId: 1 });
  await tick();
  send('stepBack', { threadId: 1 });
  await tick();
  send('reverseContinue', { threadId: 1 });
  await tick();
})();

// Does a depth-2 summary (callees' one-liners as hints) beat the bare source on a small model?
const MODEL = process.argv[2] ?? 'qwen2.5-coder:3b';
const SRC = `export async function syncUser(id: string) {
  const user = await getUser(id);
  const payload = toCrmPayload(user);
  await pushToCrm(payload);
  return user.roles.length;
}`;
const HINTS = `getUser(id): fetches the user by id and attaches its roles; throws NotFoundError when missing.
toCrmPayload(user): maps a user to the CRM contact shape, dropping internal fields.
pushToCrm(payload): POSTs the contact to the CRM API; retries 3 times then throws.`;

async function ask(prompt) {
  const t0 = performance.now();
  const r = await fetch('http://localhost:11434/api/chat', { method: 'POST', body: JSON.stringify({ model: MODEL, stream: false, options: { temperature: 0.2, num_predict: 60 }, messages: [{ role: 'system', content: 'You summarize source code tersely for a developer.' }, { role: 'user', content: prompt }] }) });
  const j = await r.json();
  return `[${Math.round(performance.now() - t0)} ms] ${j.message.content.trim()}`;
}
const base = `Summarize what this function does in one sentence of at most 25 words. Mention fallbacks or thrown errors if any. Use only the code shown`;
console.log('\n# source only\n' + await ask(`${base}.\n\n${SRC}`));
console.log('\n# source + callee summaries\n' + await ask(`${base} and the known functions.\n\nKnown functions:\n${HINTS}\n\n${SRC}`));

// Compare local models on the statement prompt: format compliance, a few factual checks, latency.
// Usage: node bench/compare.mjs model1 model2 …   (defaults to every model in `ollama list`)
import { execSync } from 'node:child_process';

const SYSTEM = `You explain one statement of source code to a developer stepping through it like a debugger.
Rules:
- Use ONLY the context given. Never guess what an unknown function does.
- If a "Resolved definition" or "Hover info" is given, "Does" MUST say what the called function actually does according to it, not just "calls X".
- Max 12 words per line. No code fences, no backticks.
- The enclosing function is shown with the current statement marked ">>". "Does" and "Watch" describe ONLY that line. "Why" may use the surrounding lines.
- "Watch" is for a real pitfall visible in the context: a null/undefined result, a thrown error, an await, a fallback value, a side effect. Otherwise "-".
- Output exactly this format, nothing else:
Does: <what happens>
Why: <role in the enclosing function>
Watch: <pitfall or "-">

Example:
Current statement:
const cfg = await loadConfig(path);
Resolved definition:
async function loadConfig(p) { const raw = await fs.readFile(p); return raw ? JSON.parse(raw) : DEFAULTS; }
Answer:
Does: Reads the file at path and parses it as JSON, or returns DEFAULTS when empty.
Why: Loads the settings the rest of the function relies on.
Watch: Falls back to DEFAULTS silently; JSON.parse can throw on bad input.`;

const FN = (line) =>
  `async function getUser(id: string) {
  const user = await db.users.find(id);
  if (!user) throw new NotFoundError();
  const roles = await getRoles(user);
  return { ...user, roles };
}`.split('\n').map((l) => (l.trim() === line ? '>>' + l.slice(2) : l)).join('\n');

// Each case: prompt + checks (regex on the whole answer, or on one field).
const cases = [
  {
    name: 'guard',
    line: 'if (!user) throw new NotFoundError();',
    extra: '',
    checks: { watch: /NotFoundError|throw/i },
  },
  {
    name: 'callee',
    line: 'const roles = await getRoles(user);',
    extra: 'Known functions:\ngetRoles(user): fetches the user\'s roles from the roles collection; returns [] when no document exists.',
    checks: { does: /roles collection|fetch|retriev|load/i, notDoes: /^calls? getRoles/i },
  },
  {
    name: 'hover',
    line: 'const user = await db.users.find(id);',
    extra: 'Hover info:\ndb.users: Collection<User>\nCollection<T>.find(id: string): Promise<T | null>',
    checks: { watch: /null|not found|undefined/i },
  },
  {
    name: 'return',
    line: 'return { ...user, roles };',
    extra: '',
    checks: { does: /merg|combin|spread|roles/i },
  },
];

const JUDGE = process.env.JUDGE ?? 'qwen3-coder:30b-a3b-q4_K_M';

/** 0 = wrong or invented, 1 = correct but shallow/tautological, 2 = correct and genuinely useful. */
async function judge(prompt, answer) {
  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      model: JUDGE, stream: false, think: false, options: { temperature: 0, num_predict: 5 },
      messages: [
        { role: 'system', content: 'You grade a short explanation of one code statement. Reply with a single digit:\n2 = every claim is true for this code AND the Why/Watch add real understanding (not a paraphrase of the line)\n1 = true but shallow: paraphrases the line, or Why just restates Does, or Watch is generic\n0 = contains a false or invented claim, or wrong format' },
        { role: 'user', content: `${prompt}\n\n--- Explanation to grade ---\n${answer}\n\nDigit:` },
      ],
    }),
  });
  const j = await res.json();
  const m = (j.message?.content ?? '').match(/[012]/);
  return m ? Number(m[0]) : 0;
}

async function ask(model, prompt) {
  const t0 = performance.now();
  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: 100 },
      // qwen3-style models only skip their reasoning preamble with this marker.
      messages: [{ role: 'system', content: SYSTEM + (/qwen3:/.test(model) ? ' /no_think' : '') }, { role: 'user', content: prompt + (/qwen3:/.test(model) ? ' /no_think' : '') }],
    }),
  });
  const json = await res.json();
  return { text: (json.message?.content ?? '').trim(), ms: Math.round(performance.now() - t0) };
}

const pick = (text, label) => text.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'))?.[1].trim() ?? '';

function sizes() {
  const out = new Map();
  for (const l of execSync('ollama list').toString().split('\n').slice(1)) {
    const m = l.trim().match(/^(\S+)\s+\S+\s+([\d.]+)\s*(GB|MB)/);
    if (m) out.set(m[1], m[3] === 'GB' ? Number(m[2]) : Number(m[2]) / 1024);
  }
  return out;
}

const sz = sizes();
const models = process.argv.slice(2).length ? process.argv.slice(2) : [...sz.keys()];
const rows = [];
for (const model of models) {
  await ask(model, 'warm up'); // load the weights before timing
  let format = 0, facts = 0, factsTotal = 0, total = 0;
  const notes = [];
  const toJudge = [];
  for (const c of cases) {
    const prompt = `Enclosing function:\n${FN(c.line)}\n\nCurrent statement:\n${c.line}${c.extra ? '\n\n' + c.extra : ''}`;
    const { text, ms } = await ask(model, prompt);
    total += ms;
    const does = pick(text, 'Does'), why = pick(text, 'Why'), watch = pick(text, 'Watch');
    const ok = does && why && text.match(/^Watch:/mi) && text.split('\n').filter((l) => l.trim()).length <= 4;
    if (ok) format++;
    toJudge.push(ok ? { prompt, text } : null);
    for (const [k, re] of Object.entries(c.checks)) {
      factsTotal++;
      const field = k === 'notDoes' ? does : { does, why, watch }[k];
      const pass = k === 'notDoes' ? !re.test(field) : re.test(field);
      if (pass) facts++;
      else notes.push(`${c.name}.${k}`);
    }
  }
  rows.push({ model, gb: sz.get(model) ?? NaN, format: `${format}/${cases.length}`, facts: `${facts}/${factsTotal}`, toJudge, judge: '', ms: Math.round(total / cases.length), notes: notes.join(' ') });
}
for (const r of rows) {
  let score = 0;
  for (const j of r.toJudge) score += j ? await judge(j.prompt, j.text) : 0;
  r.judge = `${score}/${cases.length * 2}`;
}
rows.sort((a, b) => a.gb - b.gb);
console.log('\n' + ['size GB', 'model', 'format', 'facts', 'judge', 'ms/line', 'missed'].map((h) => h.padEnd(h === 'model' ? 32 : 9)).join(''));
for (const r of rows) {
  console.log([r.gb.toFixed(1), r.model, r.format, r.facts, r.judge, String(r.ms), r.notes].map((v, i) => String(v).padEnd(i === 1 ? 32 : 9)).join(''));
}

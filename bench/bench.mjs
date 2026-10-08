// Quick bench: does a small local model give useful 1-3 line explanations
// when fed a hand-built, resolved context? Run: node bench/bench.mjs [model]
const MODEL = process.argv[2] ?? 'qwen2.5-coder:3b';
const OLLAMA = 'http://localhost:11434/api/chat';

const SYSTEM = `You explain one statement of source code to a developer stepping through it like a debugger.
Rules:
- Use ONLY the context given. Never guess what an unknown function does.
- If a "Resolved definition" or "Hover info" is given, "Does" MUST say what the called function actually does according to it, not just "calls X".
- Max 12 words per line. No code fences, no backticks.
- The enclosing function is shown in full; the line marked ">>" is the current statement. "Does" and "Watch" describe ONLY that line. "Why" may use the surrounding lines.
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

const ENCLOSING = `async function getUser(id: string) {
  const user = await db.users.find(id);
  if (!user) throw new NotFoundError();
  const roles = await getRoles(user);
  return { ...user, roles };
}`;

// Each case = what the context builder would produce for that statement.
const cases = [
  {
    name: 'explicit: guard clause (no resolution)',
    line: 'if (!user) throw new NotFoundError();',
    extra: '',
  },
  {
    name: 'explicit: return spread (no resolution)',
    line: 'return { ...user, roles };',
    extra: '',
  },
  {
    name: 'resolved: project callee',
    line: 'const roles = await getRoles(user);',
    extra: `Resolved definition (via go-to-definition):
export async function getRoles(user: User): Promise<Role[]> {
  // Roles come from the roles collection, keyed by user id. Missing doc -> []
  const doc = await db.roles.findOne({ userId: user.id });
  return doc?.roles ?? [];
}`,
  },
  {
    name: 'resolved: callee as cached one-line summary',
    line: 'const roles = await getRoles(user);',
    extra: `Known functions:
getRoles(user): fetches the user's roles from the roles collection; returns [] when no document exists.`,
  },
  {
    name: 'resolved: hover type only',
    line: 'const user = await db.users.find(id);',
    extra: `Hover info:
db.users: Collection<User>
Collection<T>.find(id: string): Promise<T | null>`,
  },
  {
    name: 'step-into: high-level summary of a function',
    line: null,
    extra: `export async function getRoles(user: User): Promise<Role[]> {
  const doc = await db.roles.findOne({ userId: user.id });
  if (!doc) return [];
  const active = doc.roles.filter(r => !r.revokedAt || r.revokedAt > Date.now());
  return active.map(r => ({ ...r, source: 'db' }));
}`,
    summary: true,
  },
];

function mark(enclosing, line) {
  return enclosing.split('\n').map((l) => (l.trim() === line.trim() ? '>>' + l.slice(2) : l)).join('\n');
}

function buildPrompt(c) {
  if (c.summary) {
    return `You are entering this function (stepped into from getUser(), which needs roles to build its response).
Summarize what it does in at most 3 short lines. Use only the code shown.

${c.extra}`;
  }
  return `Enclosing function:
${mark(ENCLOSING, c.line)}

Current statement:
${c.line}
${c.extra ? '\n' + c.extra : ''}`;
}

async function ask(prompt) {
  const t0 = performance.now();
  const res = await fetch(OLLAMA, {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false, // qwen3-style models: no reasoning preamble
      options: { temperature: 0.2, num_predict: 100 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  });
  const json = await res.json();
  return { text: json.message.content.trim(), ms: Math.round(performance.now() - t0), tokens: json.prompt_eval_count };
}

// Warm-up so the first timing isn't model load time.
await ask('Does: warm\nWhy: up\nWatch: -');

for (const c of cases) {
  const { text, ms, tokens } = await ask(buildPrompt(c));
  console.log(`\n=== ${c.name}  [${ms} ms, ${tokens} prompt tokens]`);
  if (c.line) console.log(`> ${c.line}`);
  console.log(text);
}

// Bench for the "example values" prompt: given variable names + LSP types, does the model
// produce plausible, type-conforming examples with the alternative outcome?
const MODEL = process.argv[2] ?? 'qwen2.5-coder:3b';

const SYSTEM = `You invent ONE plausible example value for each variable a statement assigns, for a developer reading code.
Rules:
- The example uses ONLY the fields listed in the type, and is never empty when the type allows content.
- Keep it tiny: one line, at most 60 chars.
- If the type allows null/undefined or the code has a fallback, add that alternative after " | ". Otherwise omit " | ".
- One line per variable, ALL of them, exactly "name = example | alternative". No prose.

Example:
Statement: const { cfg, warn } = await loadConfig(path);
Variables: cfg: Config { port: number; host: string }
warn: string | undefined
Answer:
cfg = { port: 8080, host: "localhost" }
warn = "deprecated key: ssl" | undefined`;

const cases = [
  {
    statement: 'const user = await db.users.find(id);',
    vars: 'user: User | null — User { id: string; email: string }',
  },
  {
    statement: 'const roles = await getRoles(user);',
    vars: 'roles: Role[] — Role { name: string; revokedAt?: number }\ngetRoles returns [] when no document exists',
  },
  {
    statement: 'const doc = await db.roles.findOne({ userId: user.id });',
    vars: 'doc: { userId: string; roles: Role[] } | null',
  },
  {
    statement: 'const { data, error } = await supabase.from("orders").select();',
    vars: 'data: Order[] | null — Order { id: number; total: number }\nerror: PostgrestError | null',
  },
];

for (const c of cases) {
  const t0 = performance.now();
  const res = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      options: { temperature: 0.2, num_predict: 80 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Statement: ${c.statement}\nVariables: ${c.vars}` },
      ],
    }),
  });
  const json = await res.json();
  console.log(`\n> ${c.statement}  [${Math.round(performance.now() - t0)} ms]`);
  console.log(json.message.content.trim());
}

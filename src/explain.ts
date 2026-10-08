import { ChatProvider } from './providers';

export interface Explanation {
  does: string;
  why: string;
  watch: string;
}

/** A plausible value for a variable, plus the alternative outcome when there is one. */
export interface ExampleValue {
  name: string;
  example: string;
  alternative?: string;
}

/** What the context builder hands to the model for one statement. */
export interface StatementContext {
  enclosing: string;
  statement: string;
  /** Resolved project callees, each as "name: summary". */
  callees: string[];
  hovers: string[];
  /** Variables declared by the statement, each as "name: type". */
  vars: string[];
  /** Errors the called project functions can throw, as "Name (from fn)". Deterministic. */
  throws: string[];
  /** Test titles that describe the enclosing function. Deterministic. */
  tests: string[];
  reason: string;
}

export interface Explainer {
  /** `values` is set when the provider answered both in one call (slow providers). */
  explainStatement(ctx: StatementContext): Promise<Explanation & { values?: ExampleValue[] }>;
  exampleValues(ctx: StatementContext): Promise<ExampleValue[]>;
  /** `hints` are one-line summaries of the function's own callees ("name: summary"). */
  summarizeFunction(source: string, reason: string, hints?: string[]): Promise<string>;
  answer(ctx: StatementContext, question: string): Promise<string>;
}

// Prompts validated in bench/bench.mjs and bench/values.mjs against qwen2.5-coder:3b.
const EXPLAIN_SYSTEM = `You explain one statement of source code to a developer stepping through it like a debugger.
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

const COMBINED_VALUES_RULE = `

Then, after "Watch", add a section:
Values:
<one line per declared variable: name = tiny example conforming to its type | alternative when null/undefined/fallback is possible>`;

const VALUES_SYSTEM = `You invent ONE plausible example value for each variable a statement assigns, for a developer reading code.
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

const ANSWER_SYSTEM = `You answer a developer's question about the statement they are currently stopped on while reading code.
Use ONLY the context given; say so if it is not enough. Answer in at most 4 short lines, no code fences.`;

export class PromptExplainer implements Explainer {
  private summaries = new Map<string, Promise<string>>();

  /** The provider is resolved per call, so a settings change applies to the next step. */
  constructor(
    private provider: () => ChatProvider,
    private wantValues: () => boolean = () => true,
    private language: () => string = () => 'English',
  ) {}

  async explainStatement(ctx: StatementContext): Promise<Explanation & { values?: ExampleValue[] }> {
    const combined = this.provider().slow && this.wantValues() && ctx.vars.length > 0;
    if (!combined) return parseExplanation(await this.chat(EXPLAIN_SYSTEM, contextPrompt(ctx), 100));
    // One round-trip instead of two: the values section is appended to the same answer.
    const prompt = `${contextPrompt(ctx)}\n\nVariables declared here (type after the colon):\n${ctx.vars.join('\n')}`;
    const text = await this.chat(EXPLAIN_SYSTEM + COMBINED_VALUES_RULE, prompt, 200);
    const [head, tail = ''] = text.split(/^Values:\s*$/m);
    return { ...parseExplanation(head), values: parseValues(tail, ctx.vars.map((v) => v.split(':')[0].trim())) };
  }

  async exampleValues(ctx: StatementContext): Promise<ExampleValue[]> {
    if (ctx.vars.length === 0 || !this.wantValues()) return [];
    const hints = ctx.callees.length ? `\n${ctx.callees.join('\n')}` : '';
    const text = await this.chat(VALUES_SYSTEM, `Statement: ${ctx.statement}\nVariables: ${ctx.vars.join('\n')}${hints}`, 80);
    return parseValues(text, ctx.vars.map((v) => v.split(':')[0].trim()));
  }

  summarizeFunction(source: string, reason: string, hints: string[] = []): Promise<string> {
    const key = this.provider().name + '\n' + source + '\n' + hints.join('\n'); // per provider and exact text
    let p = this.summaries.get(key);
    if (!p) {
      const known = hints.length ? `Known functions:\n${hints.join('\n')}\n\n` : '';
      const prompt = `You are entering this function${reason ? ` (${reason})` : ''}.
Summarize what it does in one sentence of at most 25 words. Mention fallbacks or thrown errors if any. Use only the code shown${hints.length ? ' and the known functions' : ''}.

${known}${source}`;
      p = this.chat('You summarize source code tersely for a developer.', prompt, 60).then((s) => s.trim());
      this.summaries.set(key, p);
    }
    return p;
  }

  async answer(ctx: StatementContext, question: string): Promise<string> {
    const text = await this.chat(ANSWER_SYSTEM, `${contextPrompt(ctx)}\n\nQuestion: ${question}`, 160);
    return text.trim();
  }

  private chat(system: string, user: string, maxTokens: number): Promise<string> {
    // Pinned explicitly: CLI providers inherit the user's own assistant preferences otherwise.
    return this.provider().chat(`${system}\n\nWrite the prose in ${this.language()}; keep the labels (Does/Why/Watch/Values) as they are.`, user, maxTokens);
  }
}

function contextPrompt(ctx: StatementContext): string {
  const parts = [`Enclosing function:\n${ctx.enclosing}`, `Current statement:\n${ctx.statement}`];
  if (ctx.callees.length) parts.push(`Known functions:\n${ctx.callees.join('\n')}`);
  if (ctx.hovers.length) parts.push(`Hover info:\n${ctx.hovers.join('\n')}`);
  if (ctx.throws.length) parts.push(`May throw: ${ctx.throws.join(', ')}`);
  if (ctx.tests.length) parts.push(`Tests describing the enclosing function:\n${ctx.tests.map((t) => '- ' + t).join('\n')}`);
  if (ctx.reason) parts.push(`Context: ${ctx.reason}`);
  return parts.join('\n\n');
}

export function parseExplanation(text: string): Explanation {
  const pick = (label: string) => text.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'))?.[1].trim() ?? '';
  const out = { does: pick('Does'), why: pick('Why'), watch: pick('Watch') };
  // Model drifted from the format: show the raw text rather than nothing.
  if (!out.does) out.does = text.trim();
  if (out.watch === '-') out.watch = '';
  return out;
}

export function parseValues(text: string, names: string[]): ExampleValue[] {
  const out: ExampleValue[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([\w$]+)\s*=\s*(.+)$/);
    if (!m || !names.includes(m[1])) continue;
    const [example, ...alt] = m[2].split(' | ');
    out.push({ name: m[1], example: example.trim(), alternative: alt.join(' | ').trim() || undefined });
  }
  return out;
}

import * as vscode from 'vscode';

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
  reason: string;
}

export interface Explainer {
  explainStatement(ctx: StatementContext): Promise<Explanation>;
  exampleValues(ctx: StatementContext): Promise<ExampleValue[]>;
  summarizeFunction(source: string, reason: string): Promise<string>;
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

export class OllamaExplainer implements Explainer {
  private summaries = new Map<string, Promise<string>>();

  private get cfg() {
    const c = vscode.workspace.getConfiguration('explain');
    return { url: c.get<string>('ollamaUrl', 'http://localhost:11434'), model: c.get<string>('model', 'qwen2.5-coder:3b') };
  }

  async explainStatement(ctx: StatementContext): Promise<Explanation> {
    const text = await this.chat(EXPLAIN_SYSTEM, contextPrompt(ctx), 100);
    return parseExplanation(text);
  }

  async exampleValues(ctx: StatementContext): Promise<ExampleValue[]> {
    if (ctx.vars.length === 0) return [];
    const hints = ctx.callees.length ? `\n${ctx.callees.join('\n')}` : '';
    const text = await this.chat(VALUES_SYSTEM, `Statement: ${ctx.statement}\nVariables: ${ctx.vars.join('\n')}${hints}`, 80);
    return parseValues(text, ctx.vars.map((v) => v.split(':')[0].trim()));
  }

  summarizeFunction(source: string, reason: string): Promise<string> {
    const key = source; // cache by exact text; a change invalidates naturally
    let p = this.summaries.get(key);
    if (!p) {
      const prompt = `You are entering this function${reason ? ` (${reason})` : ''}.
Summarize what it does in one sentence of at most 25 words. Mention fallbacks or thrown errors if any. Use only the code shown.

${source}`;
      p = this.chat('You summarize source code tersely for a developer.', prompt, 60).then((s) => s.trim());
      this.summaries.set(key, p);
    }
    return p;
  }

  async answer(ctx: StatementContext, question: string): Promise<string> {
    const text = await this.chat(ANSWER_SYSTEM, `${contextPrompt(ctx)}\n\nQuestion: ${question}`, 160);
    return text.trim();
  }

  private async chat(system: string, user: string, maxTokens: number): Promise<string> {
    const { url, model } = this.cfg;
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model,
        stream: false,
        options: { temperature: 0.2, num_predict: maxTokens },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { message: { content: string } };
    return json.message.content;
  }
}

function contextPrompt(ctx: StatementContext): string {
  const parts = [`Enclosing function:\n${ctx.enclosing}`, `Current statement:\n${ctx.statement}`];
  if (ctx.callees.length) parts.push(`Known functions:\n${ctx.callees.join('\n')}`);
  if (ctx.hovers.length) parts.push(`Hover info:\n${ctx.hovers.join('\n')}`);
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

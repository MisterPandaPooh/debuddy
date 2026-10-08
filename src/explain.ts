import * as vscode from 'vscode';

export interface Explanation {
  does: string;
  why: string;
  watch: string;
}

/** What the context builder hands to the model for one statement. */
export interface StatementContext {
  enclosing: string;
  statement: string;
  /** Resolved project callees, each as "name(sig): summary" or a code excerpt. */
  callees: string[];
  hovers: string[];
  reason: string;
}

export interface Explainer {
  explainStatement(ctx: StatementContext): Promise<Explanation>;
  summarizeFunction(source: string, reason: string): Promise<string>;
}

// Prompt validated in bench/bench.mjs against qwen2.5-coder:3b.
const SYSTEM = `You explain one statement of source code to a developer stepping through it like a debugger.
Rules:
- Use ONLY the context given. Never guess what an unknown function does.
- If a "Resolved definition" or "Hover info" is given, "Does" MUST say what the called function actually does according to it, not just "calls X".
- Max 12 words per line. No code fences, no backticks.
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

export class OllamaExplainer implements Explainer {
  private summaries = new Map<string, Promise<string>>();

  private get cfg() {
    const c = vscode.workspace.getConfiguration('explain');
    return { url: c.get<string>('ollamaUrl', 'http://localhost:11434'), model: c.get<string>('model', 'qwen2.5-coder:3b') };
  }

  async explainStatement(ctx: StatementContext): Promise<Explanation> {
    const parts = [`Enclosing function:\n${ctx.enclosing}`, `Current statement:\n${ctx.statement}`];
    if (ctx.callees.length) parts.push(`Known functions:\n${ctx.callees.join('\n')}`);
    if (ctx.hovers.length) parts.push(`Hover info:\n${ctx.hovers.join('\n')}`);
    if (ctx.reason) parts.push(`Context: ${ctx.reason}`);
    const text = await this.chat(SYSTEM, parts.join('\n\n'), 100);
    return parseExplanation(text);
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

export function parseExplanation(text: string): Explanation {
  const pick = (label: string) => text.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'))?.[1].trim() ?? '';
  const out = { does: pick('Does'), why: pick('Why'), watch: pick('Watch') };
  // Model drifted from the format: show the raw text rather than nothing.
  if (!out.does) out.does = text.trim();
  if (out.watch === '-') out.watch = '';
  return out;
}

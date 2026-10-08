import { ChatProvider } from './types';

/** Any OpenAI-compatible `/chat/completions`: OpenAI, OpenRouter, LM Studio, vLLM, Ollama's /v1. */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly name: string;
  constructor(private opts: { baseUrl: string; model: string; apiKey?: string }) {
    this.name = `openai/${opts.model}`;
  }

  async chat(system: string, user: string, maxTokens: number): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`${this.name} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    return json.choices[0]?.message.content ?? '';
  }
}

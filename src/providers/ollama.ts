import { ChatProvider } from './types';

/** Ollama's native API (default: local, small, fast). */
export class OllamaProvider implements ChatProvider {
  readonly name: string;
  constructor(private opts: { url: string; model: string }) {
    this.name = `ollama/${opts.model}`;
  }

  async chat(system: string, user: string, maxTokens: number): Promise<string> {
    const res = await fetch(`${this.opts.url}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({
        model: this.opts.model,
        stream: false,
        think: false, // reasoning models (qwen3…) answer directly
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

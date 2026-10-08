/** Every provider reduces to one chat completion; the prompts live in explain.ts. */
export interface ChatProvider {
  readonly name: string;
  /** Seconds per call rather than milliseconds: callers batch and prefetch more aggressively. */
  readonly slow?: boolean;
  chat(system: string, user: string, maxTokens: number): Promise<string>;
}

export type ProviderKind = 'embedded' | 'ollama' | 'openai' | 'vscode-lm' | 'claude-cli' | 'cursor-cli';

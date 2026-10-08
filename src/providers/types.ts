/** Every provider reduces to one chat completion; the prompts live in explain.ts. */
export interface ChatProvider {
  readonly name: string;
  /** Seconds per call rather than milliseconds: callers batch and prefetch more aggressively. */
  readonly slow?: boolean;
  chat(system: string, user: string, maxTokens: number): Promise<string>;
  /** Get ready before the first call (load weights, spawn a session). `quiet`: never prompt or download. */
  warmUp?(opts?: { quiet?: boolean }): Promise<void>;
}

export type ProviderKind = 'embedded' | 'ollama' | 'openai' | 'vscode-lm' | 'claude-cli' | 'cursor-cli';

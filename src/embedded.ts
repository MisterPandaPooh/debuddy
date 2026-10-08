import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ChatProvider } from './providers';

// Measured in bench/RESULTS.md; the GGUF names follow Qwen's official repos.
export const EMBEDDED_TIERS = [
  { id: 'hf:Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF/qwen2.5-coder-0.5b-instruct-q4_k_m.gguf', label: 'Qwen2.5-Coder 0.5B', detail: '0.5 GB · ~0.3 s/line · minimum: correct but shallow' },
  { id: 'hf:Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf', label: 'Qwen2.5-Coder 1.5B', detail: '1.1 GB · ~0.4 s/line' },
  { id: 'hf:Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/qwen2.5-coder-3b-instruct-q4_k_m.gguf', label: 'Qwen2.5-Coder 3B', detail: '2.1 GB · ~0.7 s/line · default, best balance' },
  { id: 'hf:Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/qwen2.5-coder-7b-instruct-q4_k_m.gguf', label: 'Qwen2.5-Coder 7B', detail: '4.7 GB · ~1.5 s/line · slightly deeper, twice slower' },
];
export const DEFAULT_EMBEDDED = EMBEDDED_TIERS[2].id;

type Llama = typeof import('node-llama-cpp');

/** node-llama-cpp is ESM-only; a real dynamic import keeps esbuild from turning it into require(). */
function loadLlamaCpp(): Promise<Llama> {
  return new Function('return import("node-llama-cpp")')() as Promise<Llama>;
}

/** Local file a `hf:owner/repo/file.gguf` id resolves to inside `dir`, mirroring node-llama-cpp's naming. */
export function embeddedModelPath(dir: string, id: string): string {
  const m = id.match(/^hf:([^/]+)\/[^/]+\/(.+)$/);
  return path.join(dir, m ? `hf_${m[1]}_${m[2]}` : id.replace(/[^\w.-]+/g, '_'));
}

export function isEmbeddedModelDownloaded(dir: string, id: string): boolean {
  try {
    return fs.statSync(embeddedModelPath(dir, id)).size > 1e6;
  } catch {
    return false;
  }
}

/** Download a GGUF into `dir` with a cancellable progress notification. Resolves to the file path. */
export async function downloadEmbeddedModel(dir: string, id: string): Promise<string | undefined> {
  const { createModelDownloader } = await loadLlamaCpp();
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Explain Mode: downloading ${id.split('/').pop()}`, cancellable: true },
    async (progress, token) => {
      let last = 0;
      const downloader = await createModelDownloader({
        modelUri: id,
        dirPath: dir,
        showCliProgress: false,
        onProgress: ({ totalSize, downloadedSize }) => {
          const pct = totalSize ? Math.floor((downloadedSize / totalSize) * 100) : 0;
          progress.report({ message: `${pct}% of ${(totalSize / 1e9).toFixed(1)} GB`, increment: pct - last });
          last = pct;
        },
      });
      token.onCancellationRequested(() => void downloader.cancel({ deleteTempFile: true }));
      try {
        const file = await downloader.download();
        void vscode.window.showInformationMessage(`Explain Mode: ${path.basename(file)} is ready.`);
        return file;
      } catch (err) {
        if (!token.isCancellationRequested) void vscode.window.showErrorMessage(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
        return undefined;
      }
    },
  );
}

/**
 * llama.cpp in the extension host: no Ollama, no server, nothing to install.
 * The model loads on first use (~1 s) and stays resident; calls run on a pool of sequences.
 */
export class EmbeddedProvider implements ChatProvider, vscode.Disposable {
  readonly name: string;
  private ready?: Promise<{ llama: Llama; context: import('node-llama-cpp').LlamaContext; free: import('node-llama-cpp').LlamaContextSequence[] }>;
  private waiters: (() => void)[] = [];

  constructor(private dir: string, private id: string, private sequences = 2) {
    this.name = `embedded/${id.split('/').pop()?.replace(/\.gguf$/, '')}`;
  }

  private load() {
    this.ready ??= (async () => {
      const llama = await loadLlamaCpp();
      if (!isEmbeddedModelDownloaded(this.dir, this.id)) {
        const file = await downloadEmbeddedModel(this.dir, this.id);
        if (!file) throw new Error('model download cancelled');
      }
      const engine = await llama.getLlama();
      const model = await engine.loadModel({ modelPath: embeddedModelPath(this.dir, this.id) });
      const context = await model.createContext({ contextSize: 4096, sequences: this.sequences });
      const free = Array.from({ length: this.sequences }, (_, i) => context.getSequence());
      return { llama, context, free };
    })();
    this.ready.catch(() => (this.ready = undefined));
    return this.ready;
  }

  private async acquire() {
    const r = await this.load();
    while (r.free.length === 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
    return { r, seq: r.free.pop()! };
  }

  async chat(system: string, user: string, maxTokens: number): Promise<string> {
    const { r, seq } = await this.acquire();
    try {
      const session = new r.llama.LlamaChatSession({ contextSequence: seq, systemPrompt: system });
      const out = await session.prompt(user, { maxTokens, temperature: 0.2 });
      session.dispose();
      await seq.clearHistory();
      return out;
    } finally {
      r.free.push(seq);
      this.waiters.shift()?.();
    }
  }

  dispose() {
    void this.ready?.then((r) => r.context.dispose()).catch(() => undefined);
    this.ready = undefined;
  }
}

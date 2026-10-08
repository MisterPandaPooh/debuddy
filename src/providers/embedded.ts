import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { errMsg } from '../util';
import type { ChatProvider } from './types';

// The one embedded model: the measured sweet spot (bench/RESULTS.md). Other sizes go through Ollama.
export const DEFAULT_EMBEDDED = 'hf:Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/qwen2.5-coder-3b-instruct-q4_k_m.gguf';
export const EMBEDDED_LABEL = 'Qwen2.5-Coder 3B (2.1 GB)';
export const EMBEDDED_SIZE_GB = 2.1;

type Llama = typeof import('node-llama-cpp');

/** node-llama-cpp is ESM-only; a real dynamic import keeps esbuild from turning it into require(). */
function loadLlamaCpp(): Promise<Llama> {
  return new Function('return import("node-llama-cpp")')() as Promise<Llama>;
}

const HF_ID = /^hf:([\w.-]+)\/([\w.-]+)\/([\w.-]+\.gguf)$/;

/** Only `hf:owner/repo/file.gguf` with plain names: no paths, no revisions, nothing that could escape `dir`. */
export function isValidEmbeddedId(id: string): boolean {
  return HF_ID.test(id);
}

/** Local file a `hf:owner/repo/file.gguf` id resolves to inside `dir`, mirroring node-llama-cpp's naming. */
export function embeddedModelPath(dir: string, id: string): string {
  const m = id.match(HF_ID);
  if (!m) throw new Error(`invalid embedded model id: ${id} (expected hf:owner/repo/file.gguf)`);
  return path.join(dir, path.basename(`hf_${m[1]}_${m[3]}`));
}

export function isEmbeddedModelDownloaded(dir: string, id: string): boolean {
  if (!isValidEmbeddedId(id)) return false;
  try {
    return fs.statSync(embeddedModelPath(dir, id)).size > 1e6;
  } catch {
    return false;
  }
}

/** Ask before the first download; the user may prefer Ollama. Returns false when declined. */
export async function confirmEmbeddedDownload(id: string): Promise<boolean> {
  const name = id.split('/').pop()?.replace(/\.gguf$/, '') ?? id;
  const size = id === DEFAULT_EMBEDDED ? ` (${EMBEDDED_SIZE_GB} GB)` : '';
  const choice = await vscode.window.showInformationMessage(
    `DeBuddy needs a local model: ${name}${size}. Download it now into the extension storage?`,
    { modal: true, detail: 'One-time download from Hugging Face. You can switch to Ollama or another provider instead.' },
    'Download',
    'Use Ollama instead',
  );
  if (choice === 'Use Ollama instead') {
    await vscode.workspace.getConfiguration('explain').update('provider', 'ollama', vscode.ConfigurationTarget.Global);
  }
  return choice === 'Download';
}

/** Download a GGUF into `dir` with a cancellable progress notification. Resolves to the file path. */
const declined = new Set<string>();

export async function downloadEmbeddedModel(dir: string, id: string): Promise<string | undefined> {
  if (!isValidEmbeddedId(id)) throw new Error(`invalid embedded model id: ${id}`);
  if (declined.has(id)) return undefined; // asked once this session: do not nag on every statement
  if (!(await confirmEmbeddedDownload(id))) {
    declined.add(id);
    return undefined;
  }
  const { createModelDownloader } = await loadLlamaCpp();
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `DeBuddy: downloading ${id.split('/').pop()}`, cancellable: true },
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
        void vscode.window.showInformationMessage(`DeBuddy: ${id === DEFAULT_EMBEDDED ? EMBEDDED_LABEL : path.basename(file)} is ready.`);
        return file;
      } catch (err) {
        if (!token.isCancellationRequested) void vscode.window.showErrorMessage(`Download failed: ${errMsg(err)}`);
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
  private ready?: Promise<{ llama: Llama; model: import('node-llama-cpp').LlamaModel; context: import('node-llama-cpp').LlamaContext; free: import('node-llama-cpp').LlamaContextSequence[] }>;
  private waiters: (() => void)[] = [];

  constructor(private dir: string, private id: string, private sequences = 2) {
    this.name = `embedded/${id.split('/').pop()?.replace(/\.gguf$/, '')}`;
  }

  private load() {
    this.ready ??= (async () => {
      const llama = await loadLlamaCpp();
      if (!isEmbeddedModelDownloaded(this.dir, this.id)) {
        const file = await downloadEmbeddedModel(this.dir, this.id);
        if (!file) throw new Error('model download declined or cancelled — pick a provider in the status bar');
      }
      const engine = await llama.getLlama();
      const model = await engine.loadModel({ modelPath: embeddedModelPath(this.dir, this.id) });
      const context = await model.createContext({ contextSize: 4096, sequences: this.sequences });
      const free = Array.from({ length: this.sequences }, (_, i) => context.getSequence());
      return { llama, model, context, free };
    })();
    this.ready.catch(() => (this.ready = undefined));
    return this.ready;
  }

  private async acquire() {
    const r = await this.load();
    while (r.free.length === 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
    return { r, seq: r.free.pop()! };
  }

  /** Load the model now so the first explanation does not pay the ~1 s load; quiet = only if already on disk. */
  async warmUp(opts: { quiet?: boolean } = {}): Promise<void> {
    if (opts.quiet && !isEmbeddedModelDownloaded(this.dir, this.id)) return;
    await this.load();
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
    void this.ready?.then(async (r) => {
      await r.context.dispose();
      await r.model.dispose();
    }).catch(() => undefined);
    this.ready = undefined;
  }
}

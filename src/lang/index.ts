import * as path from 'path';
import * as vscode from 'vscode';
import { genericLanguage, keywordProfileFor } from './generic';
import { pythonProfile } from './profiles/python';
import { rustProfile } from './profiles/rust';
import { setGrammarDir, treeSitterLanguage } from './treesitter';
import { Frame, LanguageSupport } from './types';
import { typescriptLanguage } from './typescript';

import { lspProjectCallee } from './lsp';
import { CallSite } from './types';

export * from './lsp';
export * from './types';

const EXT: Record<string, string[]> = { python: ['py'], rust: ['rs'], go: ['go'], java: ['java'], kotlin: ['kt'], csharp: ['cs'], cpp: ['cpp', 'cc', 'hpp', 'h'], c: ['c', 'h'], swift: ['swift'], php: ['php'], ruby: ['rb'], typescript: ['ts', 'tsx'], javascript: ['js', 'jsx', 'mjs'] };
const fallbackCache = new Map<string, Promise<vscode.Location | undefined>>();

/**
 * Where a call is defined: the language server first; without one, the walker looks for a
 * function of that name in the same file, then in the workspace files of the same language.
 */
export async function resolveProjectCallee(uri: vscode.Uri, call: CallSite): Promise<vscode.Location | undefined> {
  const viaLsp = await lspProjectCallee(uri, call);
  if (viaLsp) return viaLsp;
  const doc = await vscode.workspace.openTextDocument(uri);
  const lang = languageFor(doc);
  if (!lang.findFunction) return undefined;
  const local = await lang.findFunction(doc, call.name);
  if (local) return local;
  const key = `${doc.languageId}:${call.name}`;
  let p = fallbackCache.get(key);
  if (!p) {
    p = (async () => {
      const exts = EXT[doc.languageId] ?? [];
      if (!exts.length) return undefined;
      const files = await vscode.workspace.findFiles(`**/*.{${exts.join(',')}}`, '{**/node_modules/**,**/target/**,**/.venv/**,**/dist/**}', 200);
      const want = call.name.split(/\.|::|->/).pop()!;
      for (const f of files) {
        if (f.fsPath === uri.fsPath) continue;
        const other = await vscode.workspace.openTextDocument(f);
        if (!other.getText().includes(want)) continue;
        const loc = await lang.findFunction!(other, call.name);
        if (loc) return loc;
      }
      return undefined;
    })();
    fallbackCache.set(key, p);
    setTimeout(() => fallbackCache.delete(key), 30_000).unref?.();
  }
  return p;
}

/**
 * Exact walkers first (TypeScript compiler, tree-sitter grammars), then the LSP-generic one for
 * any language that has a language server. Add a grammar profile here to make a language exact.
 */
export const languages: LanguageSupport[] = [typescriptLanguage, treeSitterLanguage(pythonProfile), treeSitterLanguage(rustProfile)];

/** Language ids with an exact walker; the generic one accepts everything else with a keyword profile. */
export const exactLanguageIds = languages.flatMap((l) => l.languages);
export const supportedLanguageIds = [...exactLanguageIds, 'go', 'java', 'kotlin', 'scala', 'csharp', 'cpp', 'c', 'objective-c', 'dart', 'swift', 'php', 'ruby'];

/** Must run once at activation: tells tree-sitter where the extension ships its .wasm files. */
export function initLanguages(extensionPath: string) {
  setGrammarDir(path.join(extensionPath, 'dist', 'grammars'));
}

export function languageFor(doc: vscode.TextDocument): LanguageSupport {
  return languages.find((l) => l.languages.includes(doc.languageId)) ?? genericLanguage;
}

export function isSupported(doc: vscode.TextDocument): boolean {
  return exactLanguageIds.includes(doc.languageId) || keywordProfileFor(doc.languageId).languages[0] !== '*' || supportedLanguageIds.includes(doc.languageId);
}

/** Build the frame for the function containing `line` in whatever language the document is. */
export async function frameAt(doc: vscode.TextDocument, line: number, reason = ''): Promise<Frame | undefined> {
  return languageFor(doc).frameAt(doc, line, reason);
}

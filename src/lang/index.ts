import * as path from 'path';
import * as vscode from 'vscode';
import { genericLanguage, keywordProfileFor } from './generic';
import { pythonProfile } from './profiles/python';
import { rustProfile } from './profiles/rust';
import { setGrammarDir, treeSitterLanguage } from './treesitter';
import { Frame, LanguageSupport } from './types';
import { typescriptLanguage } from './typescript';

export * from './lsp';
export * from './types';

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

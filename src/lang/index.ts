import * as vscode from 'vscode';
import { typescriptLanguage } from './typescript';
import { Frame, LanguageSupport } from './types';

export * from './lsp';
export * from './types';

/** Registered languages; add an implementation here to support another one. */
export const languages: LanguageSupport[] = [typescriptLanguage];

export function languageFor(doc: vscode.TextDocument): LanguageSupport | undefined {
  return languages.find((l) => l.languages.includes(doc.languageId));
}

export const supportedLanguageIds = languages.flatMap((l) => l.languages);

/** Build the frame for the function containing `line` in whatever language the document is. */
export function frameAt(doc: vscode.TextDocument, line: number, reason = ''): Frame | undefined {
  return languageFor(doc)?.frameAt(doc, line, reason);
}

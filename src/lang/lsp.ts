import * as vscode from 'vscode';
import { CallSite } from './types';

// Language-agnostic lookups through whatever language server is active in VS Code.

/** Resolve a call to a definition inside the workspace (never node_modules). */
export async function resolveProjectCallee(
  uri: vscode.Uri,
  call: CallSite,
): Promise<vscode.Location | undefined> {
  const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeDefinitionProvider',
    uri,
    call.position,
  );
  for (const d of defs ?? []) {
    const loc = 'targetUri' in d ? new vscode.Location(d.targetUri, d.targetSelectionRange ?? d.targetRange) : d;
    const inWorkspace = vscode.workspace.getWorkspaceFolder(loc.uri) !== undefined;
    if (inWorkspace && !loc.uri.fsPath.includes('node_modules') && !loc.uri.fsPath.endsWith('.d.ts')) return loc;
  }
  return undefined;
}

/** Declaration text of the type behind a variable (interface/type/class), trimmed; project types only. */
export async function typeDefinitionText(uri: vscode.Uri, position: vscode.Position): Promise<string[]> {
  const defs = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
    'vscode.executeTypeDefinitionProvider',
    uri,
    position,
  );
  const out: string[] = [];
  for (const d of (defs ?? []).slice(0, 3)) {
    const loc = 'targetUri' in d ? new vscode.Location(d.targetUri, d.targetRange) : d;
    if (loc.uri.fsPath.includes('node_modules') || loc.uri.fsPath.includes('/typescript/lib/')) continue;
    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const text = doc.getText(loc.range).split('\n').slice(0, 12).join(' ').replace(/\s+/g, ' ').trim();
    if (text) out.push(text.slice(0, 240));
  }
  return out;
}

/** Files that reference the symbol at `position`, as "basename:line" (excluding `position` itself). */
export async function referencesOf(uri: vscode.Uri, position: vscode.Position, limit = 5): Promise<string[]> {
  const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, position);
  const out: string[] = [];
  for (const r of refs ?? []) {
    if (r.uri.fsPath === uri.fsPath && r.range.start.line === position.line) continue;
    if (r.uri.fsPath.includes('node_modules')) continue;
    const name = r.uri.fsPath.split('/').pop();
    out.push(`${name}:${r.range.start.line + 1}`);
    if (out.length >= limit) break;
  }
  return out;
}

/** Hover text for a position, flattened to one line. */
export async function hoverText(uri: vscode.Uri, position: vscode.Position): Promise<string | undefined> {
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, position);
  const parts = (hovers ?? []).flatMap((h) =>
    h.contents.map((c) => (typeof c === 'string' ? c : c.value)),
  );
  const text = parts.join(' ').replace(/```\w*/g, '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 200) : undefined;
}

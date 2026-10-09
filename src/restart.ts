import * as vscode from 'vscode';

/**
 * Stop the DeBuddy session that is running and start it again with the same launch config: a
 * clean walk on the model or provider that was just set up. False when no session was running.
 */
export async function restartExplainSession(): Promise<boolean> {
  const session = vscode.debug.activeDebugSession;
  if (session?.type !== 'explain') return false;
  const { workspaceFolder, configuration } = session;
  await vscode.debug.stopDebugging(session);
  return vscode.debug.startDebugging(workspaceFolder, configuration);
}

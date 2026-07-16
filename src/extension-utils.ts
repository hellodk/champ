import * as vscode from "vscode";

/**
 * Returns the fsPath of the workspace folder that owns the active editor's
 * file. Falls back to workspaceFolders[0] when no editor is active or the
 * active file isn't inside any workspace folder. Returns undefined when no
 * workspace folders are open at all.
 */
export function resolveActiveWorkspaceFolder(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;

  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) return folder.uri.fsPath;
  }

  return folders[0].uri.fsPath;
}

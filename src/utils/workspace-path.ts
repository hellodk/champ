/**
 * Workspace path utilities.
 *
 * All tools that accept a file path must pass it through `resolveInWorkspace`
 * to prevent path traversal attacks. The function rejects paths that
 * resolve outside the workspace root.
 */
import * as path from "path";

/**
 * Resolve a user-supplied relative path against the workspace root and
 * verify it stays within the workspace. Returns null if the path would
 * escape the workspace.
 */
export function resolveInWorkspace(
  workspaceRoot: string,
  relativePath: string,
): string | null {
  // Normalize the workspace root to an absolute path.
  const root = path.resolve(workspaceRoot);
  // Resolve the relative path against the root.
  const resolved = path.resolve(root, relativePath);

  // Ensure the resolved path is within the workspace. We compare with a
  // trailing separator on the root so "workspace2" isn't considered inside
  // "workspace".
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    return null;
  }

  return resolved;
}

/**
 * Returns true if a relative path would escape the workspace root.
 */
export function isOutsideWorkspace(
  workspaceRoot: string,
  relativePath: string,
): boolean {
  return resolveInWorkspace(workspaceRoot, relativePath) === null;
}

/**
 * Workspace path utilities.
 *
 * All tools that accept a file path must pass it through `resolveInWorkspace`
 * to prevent path traversal attacks. The function rejects paths that
 * resolve outside the workspace root.
 */
import * as path from "path";
import * as fs from "fs";

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
  // Resolve the relative path against the root (string-only, no I/O).
  const resolved = path.resolve(root, relativePath);

  // String-level boundary check — catches plain traversal like ../../etc.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    return null;
  }

  // Symlink check: resolve the real path on disk and re-verify the boundary.
  // This blocks symlinks inside the workspace pointing outside it.
  // If the path doesn't exist yet (new file), realpathSync will throw —
  // in that case the string check above is sufficient.
  try {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(root);
    const realRootWithSep = realRoot.endsWith(path.sep)
      ? realRoot
      : realRoot + path.sep;
    if (real !== realRoot && !real.startsWith(realRootWithSep)) {
      return null;
    }
  } catch {
    // Path doesn't exist yet — string check is sufficient.
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

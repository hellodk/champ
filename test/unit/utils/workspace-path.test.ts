/**
 * Tests for src/utils/workspace-path.ts traversal guard (#112).
 *
 * resolveInWorkspace is the single choke point all file tools must pass
 * user-supplied paths through: string-level boundary check + on-disk
 * symlink (realpath) re-verification.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveInWorkspace, isOutsideWorkspace } from "@/utils/workspace-path";

describe("resolveInWorkspace", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-path-test-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "main.ts"), "export {};\n");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves a normal relative path to a location inside the root", () => {
    const result = resolveInWorkspace(root, path.join("src", "main.ts"));
    expect(result).toBe(path.join(root, "src", "main.ts"));
  });

  it("returns the root itself for '.'", () => {
    expect(resolveInWorkspace(root, ".")).toBe(root);
  });

  it("accepts a relative path whose file does not exist yet (string check only)", () => {
    const result = resolveInWorkspace(root, path.join("newdir", "new-file.md"));
    expect(result).toBe(path.join(root, "newdir", "new-file.md"));
  });

  it("rejects a dotdot escape above the root", () => {
    expect(
      resolveInWorkspace(root, path.join("..", "..", "etc", "passwd")),
    ).toBeNull();
  });

  it("rejects an absolute path outside the root", () => {
    expect(resolveInWorkspace(root, "/etc/passwd")).toBeNull();
  });

  it("accepts an absolute path that is inside the root", () => {
    const inside = path.join(root, "src", "main.ts");
    expect(resolveInWorkspace(root, inside)).toBe(inside);
  });

  it("rejects a symlink inside the workspace pointing outside it", () => {
    // Real target lives OUTSIDE the workspace root
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ws-path-outside-"),
    );
    try {
      const secret = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(secret, "top secret\n");
      fs.symlinkSync(outsideDir, path.join(root, "leak"));

      const result = resolveInWorkspace(root, path.join("leak", "secret.txt"));
      expect(result).toBeNull();
      expect(isOutsideWorkspace(root, path.join("leak", "secret.txt"))).toBe(
        true,
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects a nested symlink chain whose final target is outside the root", () => {
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ws-path-outside-"),
    );
    try {
      const secret = path.join(outsideDir, "secret.txt");
      fs.writeFileSync(secret, "top secret\n");

      // Chain: ws/link-a -> ws/inner/link-b -> <outside>/  (two hops)
      fs.mkdirSync(path.join(root, "inner"));
      fs.symlinkSync(outsideDir, path.join(root, "inner", "link-b"));
      fs.symlinkSync(path.join("inner", "link-b"), path.join(root, "link-a"));

      const result = resolveInWorkspace(
        root,
        path.join("link-a", "secret.txt"),
      );
      expect(result).toBeNull();
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows a symlink that points back inside the workspace", () => {
    fs.symlinkSync(
      path.join(root, "src", "main.ts"),
      path.join(root, "alias.ts"),
    );
    const result = resolveInWorkspace(root, "alias.ts");
    expect(result).not.toBeNull();
  });
});

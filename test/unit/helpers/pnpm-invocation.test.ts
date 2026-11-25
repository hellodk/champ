/**
 * TDD: E2E packaging tests must use the package manager installed by CI, not
 * Corepack's latest-version lookup from a directory with no package.json.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function fakeBin(name: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(path.join(tmpdir(), "champ-pnpm-invocation-"));
  const suffix = process.platform === "win32" ? ".CMD" : "";
  writeFileSync(path.join(dir, `${name}${suffix}`), "", { mode: 0o755 });
  return {
    dir,
    env: {
      PATH: `${dir}${path.delimiter}/usr/bin`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    },
  };
}

describe("pnpm invocation helper", () => {
  it("prefers pnpm when it is on PATH", async () => {
    const { pnpmInvocation } = await import("../../helpers/pnpm-invocation");
    const { dir, env } = fakeBin("pnpm");
    try {
      expect(pnpmInvocation(env, process.platform)).toEqual([
        path.join(dir, process.platform === "win32" ? "pnpm.CMD" : "pnpm"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to corepack pnpm when pnpm is not on PATH", async () => {
    const { pnpmInvocation } = await import("../../helpers/pnpm-invocation");
    const { dir, env } = fakeBin("corepack");
    try {
      expect(pnpmInvocation(env, process.platform)).toEqual([
        path.join(
          dir,
          process.platform === "win32" ? "corepack.CMD" : "corepack",
        ),
        "pnpm",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly when neither pnpm nor Corepack is available", async () => {
    const { pnpmInvocation } = await import("../../helpers/pnpm-invocation");
    const dir = mkdtempSync(path.join(tmpdir(), "champ-pnpm-empty-"));
    try {
      expect(() =>
        pnpmInvocation({ PATH: dir, PATHEXT: ".COM" }, process.platform),
      ).toThrow(/pnpm.*PATH/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the helper in the browser packaging E2E test", () => {
    const source = readFileSync(
      path.join(ROOT, "test/e2e/browser-runtime-packaging.test.ts"),
      "utf8",
    );
    expect(source).toContain("pnpmInvocation()");
    expect(source).not.toContain('"corepack"');
  });
});

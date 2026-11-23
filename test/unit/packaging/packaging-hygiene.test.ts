import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Regression guard for issue #102.
 *
 * Contract:
 * 1. graphify-out/, .champ/team-runs/ and .superpowers/ are never git-tracked,
 *    so they can never be pushed to GitHub.
 * 2. .gitignore lists all four runtime/internal directories.
 * 3. .vscodeignore keeps internal docs, code-graph artifacts, runtime data and
 *    lockfiles out of the published VSIX, while README.md / LICENSE stay in
 *    (vsce requires both).
 */

const ROOT = path.resolve(__dirname, "../../..");

const readLines = (rel: string): string[] =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .split("\n")
    .map((l) => l.trim());

/**
 * execFileSync does not apply PATHEXT on Windows. Also fall back to corepack
 * so the test works in a plain shell where only `corepack pnpm` is available.
 */
function findOnPath(name: string): string | null {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
        return candidate;
      }
    }
  }
  return null;
}

function pnpmInvocation(): [string, ...string[]] {
  const pnpm = findOnPath("pnpm");
  if (pnpm) return [pnpm];
  const corepack = findOnPath("corepack");
  if (corepack) return [corepack, "pnpm"];
  return ["pnpm"];
}

describe("packaging + repo hygiene (#102)", () => {
  it("never tracks graphify-out, .champ/team-runs or .superpowers in git", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: ROOT,
      encoding: "utf8",
    }).split("\n");
    const leaked = tracked.filter(
      (f) =>
        f.startsWith("graphify-out/") ||
        f.startsWith(".champ/team-runs/") ||
        f.startsWith(".superpowers/"),
    );
    expect(leaked).toEqual([]);
  });

  it(".gitignore lists all runtime/internal directories", () => {
    const lines = readLines(".gitignore");
    for (const entry of [
      "graphify-out/",
      ".champ/team-runs/",
      ".superpowers/",
      ".worktrees/",
    ]) {
      expect(lines).toContain(entry);
    }
  });

  it(".vscodeignore excludes internals and user data from the VSIX", () => {
    const patterns = readLines(".vscodeignore");
    for (const pat of [
      "graphify-out/**",
      ".champ/**",
      ".superpowers/**",
      ".worktrees/**",
      "docs/**",
      "test-reports/**",
      "examples/**",
      "marketplace/**",
      "pnpm-lock.yaml",
      "package-lock.json",
      "pending-items.md",
      "OPTIMIZATIONS.md",
      "CHANGELOG.md",
    ]) {
      expect(patterns).toContain(pat);
    }
  });

  it("keeps vsce-required files packaged", () => {
    const excluded = new Set(readLines(".vscodeignore"));
    // README.md and LICENSE must NOT appear as exclusion patterns
    expect(excluded.has("README.md")).toBe(false);
    expect(excluded.has("LICENSE")).toBe(false);
  });

  it("packs the CLI tarball without repository or user state (#139)", () => {
    const [pm, ...pmPrefix] = pnpmInvocation();
    const isWin = process.platform === "win32";
    // Node refuses to spawn a .CMD shim without a shell on Windows.
    const quote = (value: string) =>
      isWin && /\s/.test(value) ? `"${value}"` : value;
    const stdout = execFileSync(
      pm,
      [
        ...pmPrefix,
        "pack",
        "--dry-run",
        "--json",
        "--pack-destination",
        quote(ROOT),
      ],
      { cwd: ROOT, encoding: "utf8", shell: isWin },
    );
    // pnpm prints lifecycle-script output before the JSON, and emits one object
    // rather than npm's one-element array.
    const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as {
      files: Array<{ path: string }>;
    };
    const packed = report.files.map((f) => f.path.replace(/\\/g, "/"));

    // The published artifact is the standalone CLI bundle plus the manifest and
    // licence/readme npm always includes. Everything else is dead weight, and
    // `.champ/` is user/team state that must never leave the machine.
    expect(packed.length).toBeGreaterThan(0);
    const allowed = new Set([
      "package.json",
      "README.md",
      "LICENSE",
      "dist/cli.js",
    ]);
    expect(packed.filter((p) => !allowed.has(p))).toEqual([]);
    // A tarball whose `bin` target is missing installs a command that cannot
    // run. `prepack` builds it, so no `--ignore-scripts` here (review 4c).
    expect(packed).toContain("dist/cli.js");
  });

  it("declares the CLI-only npm payload and keeps vsce off it (#139)", () => {
    const npmignore = readLines(".npmignore");
    expect(npmignore).toContain("*");
    expect(npmignore).toContain("!dist/");
    expect(npmignore).toContain("!dist/cli.js");
    expect(readLines(".vscodeignore")).toContain(".npmignore");

    // `files` would also filter the VSIX (vsce honours manifest.files), so the
    // npm payload must stay declared in .npmignore only.
    const manifest = JSON.parse(
      readFileSync(path.join(ROOT, "package.json"), "utf8"),
    ) as {
      files?: unknown;
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(manifest.files).toBeUndefined();
    expect(manifest.engines?.node).toBe(">=20");
    // `npm pack` from a clean checkout must build the bin it points at
    // (review 4c) — CI runs this suite without a prior build.
    expect(manifest.scripts?.prepack).toBe("node esbuild.mjs --production");
  });

  it("documents installing the headless CLI (#139)", () => {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    expect(readme).toContain("Headless CLI");
    expect(readme).toContain("npm pack");
    expect(readme).toContain("champ --version");
  });

  it("never value-imports playwright statically (activation crash guard)", () => {
    // esbuild marks playwright-core external and published packages ship
    // without node_modules. A static import becomes a top-level require
    // and crashes activation ("Cannot find module 'playwright-core'").
    // Type-only imports are erased at build time and are fine.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name.endsWith(".test.ts")) continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (p.endsWith(".ts")) {
          const src = readFileSync(p, "utf8");
          const re =
            /^import\s+(?!type\b)[^;]*["'](@playwright\/test|playwright-core)["']/gm;
          if (re.test(src)) offenders.push(path.relative(ROOT, p));
        }
      }
    };
    walk(path.join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });
});

/**
 * Self-update command for the standalone `champ` CLI (`champ update`).
 *
 * Clones the upstream repository into a temporary directory, builds the
 * production CLI bundle, packs a tarball, and installs it globally via npm —
 * matching the documented one-line installer without touching local config.
 * Side effects are injected through `UpdateDeps` so unit tests can cover all
 * branches without hitting the network.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

declare const __CHAMP_BUILD_COMMIT__: string | undefined;

export const DEFAULT_UPDATE_REPO = "https://github.com/hellodk/champ.git";

export interface UpdateCommandOptions {
  check: boolean;
  force: boolean;
  ref?: string;
  repo?: string;
  prefix?: string;
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { cwd: string },
) => string;

export interface UpdateDeps {
  packageRoot?: string;
  currentVersion?: string;
  currentCommit?: string;
  nodeExecPath?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  exec?: ExecFn;
  existsSync?: (target: string) => boolean;
  readFileSync?: (target: string, encoding: BufferEncoding) => string;
  readdirSync?: (target: string) => string[];
  mkdtempSync?: (prefix: string) => string;
  rmSync?: (
    target: string,
    opts: { recursive: boolean; force: boolean },
  ) => void;
  tmpdir?: () => string;
}

interface PackageManifest {
  version?: unknown;
  repository?: unknown;
}

/** Normalize a repository URL from package.json, env, or CLI flags. */
export function normalizeRepoUrl(raw?: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return DEFAULT_UPDATE_REPO;
  const withoutGitPlus = trimmed.startsWith("git+")
    ? trimmed.slice(4)
    : trimmed;
  return withoutGitPlus.replace(/\/+$/, "");
}

/** Validate an update flag value to block empty strings and git flag injection. */
export function validateRepoOrRef(
  value: string,
  label: "repo" | "ref",
): string | null {
  const trimmed = value.trim();
  if (!trimmed) return `${label} cannot be empty`;
  if (trimmed.startsWith("-")) {
    return `invalid ${label} "${trimmed}" — cannot start with "-"`;
  }
  if (label === "ref" && /\s/.test(trimmed)) {
    return `invalid ref "${trimmed}" — cannot contain whitespace`;
  }
  return null;
}

/** Compare two semver strings (`major.minor.patch[-pre]`). Returns -1, 0, or 1. */
export function compareSemver(a: string, b: string): number {
  const parse = (
    v: string,
  ): { nums: [number, number, number]; pre: string } => {
    const clean = v.trim().replace(/^v/, "");
    const [core, ...rest] = clean.split("-");
    const parts = core.split(".").map((n) => Number.parseInt(n, 10));
    return {
      nums: [
        Number.isFinite(parts[0]) ? parts[0] : 0,
        Number.isFinite(parts[1]) ? parts[1] : 0,
        Number.isFinite(parts[2]) ? parts[2] : 0,
      ],
      pre: rest.join("-"),
    };
  };

  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] > pb.nums[i]) return 1;
    if (pa.nums[i] < pb.nums[i]) return -1;
  }
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre > pb.pre ? 1 : -1;
}

/** True when a short or full SHA matches another commit SHA prefix. */
export function sameCommitPrefix(a: string, b: string): boolean {
  const ca = a.trim().toLowerCase();
  const cb = b.trim().toLowerCase();
  if (!ca || !cb || ca === "unknown" || cb === "unknown") return false;
  return ca.startsWith(cb) || cb.startsWith(ca);
}

function readManifest(
  dir: string,
  readFile: (p: string, enc: BufferEncoding) => string,
  exists: (p: string) => boolean,
): { version: string; repoUrl?: string } {
  const manifestPath = path.join(dir, "package.json");
  if (!exists(manifestPath)) return { version: "unknown" };
  try {
    const raw = JSON.parse(readFile(manifestPath, "utf8")) as PackageManifest;
    const version = typeof raw.version === "string" ? raw.version : "unknown";
    let repoUrl: string | undefined;
    if (typeof raw.repository === "string") {
      repoUrl = raw.repository;
    } else if (
      raw.repository &&
      typeof raw.repository === "object" &&
      "url" in raw.repository &&
      typeof (raw.repository as { url?: unknown }).url === "string"
    ) {
      repoUrl = (raw.repository as { url: string }).url;
    }
    return { version, repoUrl };
  } catch {
    return { version: "unknown" };
  }
}

function formatExecError(err: unknown): string {
  if (err && typeof err === "object") {
    const rec = err as {
      stderr?: unknown;
      stdout?: unknown;
      message?: unknown;
      code?: unknown;
    };
    const stderrText =
      typeof rec.stderr === "string"
        ? rec.stderr.trim()
        : Buffer.isBuffer(rec.stderr)
          ? rec.stderr.toString("utf8").trim()
          : "";
    if (stderrText) return stderrText;
    if (typeof rec.message === "string" && rec.message.trim()) {
      return rec.message.trim();
    }
  }
  return String(err);
}

function defaultExec(
  file: string,
  args: string[],
  opts: { cwd: string },
): string {
  return execFileSync(file, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Check prerequisites and update (or report status for) the global CLI install. */
export async function runUpdateCommand(
  options: UpdateCommandOptions,
  deps: UpdateDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const exec = deps.exec ?? defaultExec;
  const exists = deps.existsSync ?? fs.existsSync;
  const readFile = deps.readFileSync ?? fs.readFileSync;
  const readdir = deps.readdirSync ?? fs.readdirSync;
  const mkdtemp = deps.mkdtempSync ?? fs.mkdtempSync;
  const rm = deps.rmSync ?? fs.rmSync;
  const tmpdir = deps.tmpdir ?? os.tmpdir;
  const env = deps.env ?? process.env;
  const nodeExecPath = deps.nodeExecPath ?? process.execPath;
  const packageRoot = deps.packageRoot ?? path.resolve(__dirname, "..");

  const manifest = readManifest(packageRoot, readFile, exists);
  const currentVersion = deps.currentVersion ?? manifest.version;
  const embeddedCommit =
    typeof __CHAMP_BUILD_COMMIT__ !== "undefined"
      ? __CHAMP_BUILD_COMMIT__
      : undefined;
  const currentCommit = deps.currentCommit ?? embeddedCommit ?? "unknown";

  const rawRepo = options.repo ?? env.CHAMP_UPDATE_REPO ?? manifest.repoUrl;
  const repoErr =
    rawRepo !== undefined ? validateRepoOrRef(rawRepo, "repo") : null;
  if (repoErr) {
    stderr(`champ: ${repoErr}\n`);
    return 2;
  }
  if (options.ref !== undefined) {
    const refErr = validateRepoOrRef(options.ref, "ref");
    if (refErr) {
      stderr(`champ: ${refErr}\n`);
      return 2;
    }
  }
  const repoUrl = normalizeRepoUrl(rawRepo);

  // Protect developer `npm link` checkouts from accidental global overwrite.
  if (
    exists(path.join(packageRoot, ".git")) &&
    !options.check &&
    !options.force
  ) {
    stderr(
      `champ: running from a local git checkout (${packageRoot}).\n` +
        `champ: pull and rebuild directly (` +
        "`git pull && node esbuild.mjs --production`" +
        `), or pass --force to install globally from ${repoUrl}.\n`,
    );
    return 1;
  }

  for (const tool of ["git", "npm"] as const) {
    try {
      exec(tool, ["--version"], { cwd: packageRoot });
    } catch {
      stderr(`champ: missing required tool '${tool}' on PATH.\n`);
      return 1;
    }
  }

  const targetRef = options.ref ?? "HEAD";
  let remoteFullSha = "";
  try {
    const lsOut = exec("git", ["ls-remote", repoUrl, targetRef], {
      cwd: tmpdir(),
    });
    const firstLine = lsOut
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    remoteFullSha = firstLine ? firstLine.split(/\s+/)[0] : "";
  } catch (err) {
    stderr(`champ: failed to query ${repoUrl}: ${formatExecError(err)}\n`);
    return 1;
  }

  if (!remoteFullSha) {
    stderr(`champ: ref "${targetRef}" not found in ${repoUrl}.\n`);
    return 1;
  }
  const remoteShortSha = remoteFullSha.slice(0, 7);

  if (
    !options.check &&
    !options.force &&
    sameCommitPrefix(currentCommit, remoteFullSha)
  ) {
    stdout(
      `Already up to date: champ ${currentVersion} (${remoteShortSha}).\n`,
    );
    return 0;
  }

  const workDir = mkdtemp(path.join(tmpdir(), "champ-update-"));
  const cloneDir = path.join(workDir, "champ");
  try {
    stderr(
      `[champ] fetching ${repoUrl} (${options.ref ?? "default branch"})...\n`,
    );
    const cloneArgs = [
      "clone",
      "--depth",
      "1",
      ...(options.ref ? ["--branch", options.ref] : []),
      repoUrl,
      cloneDir,
    ];
    try {
      exec("git", cloneArgs, { cwd: workDir });
    } catch (err) {
      stderr(`champ: git clone failed: ${formatExecError(err)}\n`);
      return 1;
    }

    const remoteManifest = readManifest(cloneDir, readFile, exists);
    const targetVersion = remoteManifest.version;
    let headShort = remoteShortSha;
    try {
      const parsed = exec("git", ["rev-parse", "--short", "HEAD"], {
        cwd: cloneDir,
      }).trim();
      if (parsed) headShort = parsed;
    } catch {
      // ls-remote short SHA is already available as fallback.
    }

    const versionCmp = compareSemver(targetVersion, currentVersion);
    const commitKnown = Boolean(currentCommit && currentCommit !== "unknown");
    const sameCommit =
      commitKnown && sameCommitPrefix(currentCommit, remoteFullSha);

    if (options.check) {
      if (versionCmp > 0) {
        stdout(
          `Update available: champ ${currentVersion} -> ${targetVersion} (${headShort}). Run 'champ update' to install.\n`,
        );
      } else if (commitKnown && !sameCommit) {
        stdout(
          `Update available: champ ${currentVersion} (${currentCommit} -> ${headShort}). Run 'champ update' to install.\n`,
        );
      } else if (!commitKnown) {
        stdout(
          `Current: champ ${currentVersion}; remote: ${targetVersion} (${headShort}). Run 'champ update' to install.\n`,
        );
      } else {
        stdout(`Already up to date: champ ${currentVersion} (${headShort}).\n`);
      }
      return 0;
    }

    if (!options.force && versionCmp === 0 && sameCommit) {
      stdout(`Already up to date: champ ${currentVersion} (${headShort}).\n`);
      return 0;
    }

    stderr(
      `[champ] building champ ${targetVersion} (${headShort}) [${currentVersion} -> ${targetVersion}]...\n`,
    );
    try {
      exec(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
        ],
        { cwd: cloneDir },
      );
      exec(nodeExecPath, ["esbuild.mjs", "--production"], { cwd: cloneDir });
      exec("npm", ["pack", "--ignore-scripts", "--pack-destination", workDir], {
        cwd: cloneDir,
      });
    } catch (err) {
      stderr(`champ: build failed: ${formatExecError(err)}\n`);
      return 1;
    }

    const tgzName = readdir(workDir).find((name) => name.endsWith(".tgz"));
    if (!tgzName) {
      stderr(`champ: npm pack did not produce a .tgz archive in ${workDir}.\n`);
      return 1;
    }
    const tarballPath = path.join(workDir, tgzName);

    const installArgs = [
      "install",
      "--global",
      "--force",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...(options.prefix ? ["--prefix", options.prefix] : []),
      tarballPath,
    ];
    stderr(`[champ] installing ${tgzName}...\n`);
    try {
      exec("npm", installArgs, { cwd: workDir });
    } catch (err) {
      const msg = formatExecError(err);
      stderr(`champ: global install failed: ${msg}\n`);
      if (/EACCES|permission denied/i.test(msg)) {
        stderr(
          `champ: hint — pass --prefix <writable-dir> or configure a user npm prefix (npm config set prefix ~/.npm-global).\n`,
        );
      }
      return 1;
    }

    stdout(`Updated champ to ${targetVersion} (${headShort}).\n`);
    return 0;
  } finally {
    rm(workDir, { recursive: true, force: true });
  }
}

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  compareSemver,
  DEFAULT_UPDATE_REPO,
  normalizeRepoUrl,
  parseGithubRepo,
  runUpdateCommand,
  sameCommitPrefix,
  validateRepoOrRef,
  type ExecFn,
  type UpdateDeps,
} from "@/cli/update";

interface RecordedCall {
  file: string;
  args: string[];
  cwd: string;
}

function makeHarness(overrides: {
  installedVersion?: string;
  installedCommit?: string;
  installedRepo?: string;
  isGitCheckout?: boolean;
  remoteSha?: string;
  remoteVersion?: string;
  env?: Record<string, string>;
  execImpl?: (
    call: RecordedCall,
    cloneDir: string | null,
    workDir: string,
  ) => string;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "champ-upd-test-"));
  const pkgRoot = path.join(root, "pkg");
  fs.mkdirSync(pkgRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pkgRoot, "package.json"),
    JSON.stringify({
      name: "champ",
      version: overrides.installedVersion ?? "2.0.2",
      repository: {
        type: "git",
        url: overrides.installedRepo ?? "git+https://github.com/hellodk/champ",
      },
    }),
  );
  if (overrides.isGitCheckout) {
    fs.mkdirSync(path.join(pkgRoot, ".git"));
  }

  const out: string[] = [];
  const err: string[] = [];
  const calls: RecordedCall[] = [];
  let createdWorkDir = "";

  const remoteSha =
    overrides.remoteSha ?? "9999999abcdef1234567890abcdef1234567890ab";

  const exec: ExecFn = (file, args, opts) => {
    const call = { file, args, cwd: opts.cwd };
    calls.push(call);
    if (overrides.execImpl) {
      return overrides.execImpl(
        call,
        createdWorkDir ? path.join(createdWorkDir, "champ") : null,
        createdWorkDir,
      );
    }

    if (file === "git" && args[0] === "--version")
      return "git version 2.43.0\n";
    if (file === "npm" && args[0] === "--version") return "10.2.0\n";
    if (file === "git" && args[0] === "ls-remote") {
      return `${remoteSha}\tHEAD\n`;
    }
    if (file === "git" && args[0] === "clone") {
      const targetDir = args[args.length - 1];
      createdWorkDir = path.dirname(targetDir);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, "package.json"),
        JSON.stringify({
          name: "champ",
          version: overrides.remoteVersion ?? "2.1.0",
        }),
      );
      return "";
    }
    if (file === "git" && args[0] === "rev-parse") {
      return `${remoteSha.slice(0, 7)}\n`;
    }
    if (file === "npm" && args[0] === "pack") {
      const destIdx = args.indexOf("--pack-destination");
      const dest = destIdx !== -1 ? args[destIdx + 1] : opts.cwd;
      fs.writeFileSync(
        path.join(dest, `champ-${overrides.remoteVersion ?? "2.1.0"}.tgz`),
        "fake-tgz",
      );
      return "";
    }
    return "";
  };

  const deps: UpdateDeps = {
    packageRoot: pkgRoot,
    currentCommit: overrides.installedCommit,
    nodeExecPath: "/usr/bin/node",
    env: overrides.env ?? {},
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    exec,
    fetchFn: async () => {
      throw new Error("no release in test harness");
    },
  };

  return {
    root,
    pkgRoot,
    out,
    err,
    calls,
    deps,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe("cli update helpers", () => {
  it("normalizes git+ repository URLs and defaults cleanly", () => {
    expect(normalizeRepoUrl()).toBe(DEFAULT_UPDATE_REPO);
    expect(normalizeRepoUrl("git+https://github.com/hellodk/champ/")).toBe(
      "https://github.com/hellodk/champ",
    );
    expect(normalizeRepoUrl("https://example.com/repo.git/")).toBe(
      "https://example.com/repo.git",
    );
  });

  it("compares semver versions accurately", () => {
    expect(compareSemver("2.1.0", "2.0.2")).toBe(1);
    expect(compareSemver("2.0.2", "2.0.2")).toBe(0);
    expect(compareSemver("2.0.1", "2.0.2")).toBe(-1);
    expect(compareSemver("v2.0.2", "2.0.2-rc1")).toBe(1);
  });

  it("matches short and full commit prefixes cleanly", () => {
    expect(sameCommitPrefix("abc1234", "abc1234567890")).toBe(true);
    expect(sameCommitPrefix("ABC1234", "abc1234")).toBe(true);
    expect(sameCommitPrefix("unknown", "unknown")).toBe(false);
    expect(sameCommitPrefix("def9999", "abc1234567")).toBe(false);
  });

  it("rejects empty or option-like repo/ref strings", () => {
    expect(validateRepoOrRef("", "ref")).toMatch(/empty/);
    expect(validateRepoOrRef("--upload-pack=x", "repo")).toMatch(/start with/);
    expect(validateRepoOrRef("main --bad", "ref")).toMatch(/whitespace/);
    expect(validateRepoOrRef("v2.0.3", "ref")).toBeNull();
  });
});

describe("runUpdateCommand", () => {
  it("reports available update on --check without installing", async () => {
    const h = makeHarness({
      installedVersion: "2.0.2",
      installedCommit: "1111111",
      remoteVersion: "2.1.0",
      remoteSha: "2222222abcdef",
    });
    try {
      const code = await runUpdateCommand(
        { check: true, force: false },
        h.deps,
      );
      expect(code).toBe(0);
      expect(h.out.join("")).toContain(
        "Update available: champ 2.0.2 -> 2.1.0 (2222222)",
      );
      expect(
        h.calls.some((c) => c.file === "npm" && c.args[0] === "install"),
      ).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("short-circuits when commit already matches HEAD and cleans nothing leftover", async () => {
    const h = makeHarness({
      installedVersion: "2.0.2",
      installedCommit: "abc1234",
      remoteSha: "abc1234deadbeef",
    });
    try {
      const code = await runUpdateCommand(
        { check: false, force: false },
        h.deps,
      );
      expect(code).toBe(0);
      expect(h.out.join("")).toContain(
        "Already up to date: champ 2.0.2 (abc1234)",
      );
      expect(h.calls.some((c) => c.args[0] === "clone")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("runs clone, build, pack, and global install cleanly with --ref and --prefix", async () => {
    const h = makeHarness({
      installedVersion: "2.0.2",
      installedCommit: "1111111",
      remoteVersion: "2.0.3",
      remoteSha: "3333333abcdef",
    });
    try {
      const code = await runUpdateCommand(
        {
          check: false,
          force: false,
          ref: "v2.0.3",
          prefix: "/tmp/custom-prefix",
        },
        h.deps,
      );
      expect(code).toBe(0);
      expect(h.out.join("")).toContain("Updated champ to 2.0.3 (3333333)");

      const cloneCall = h.calls.find(
        (c) => c.file === "git" && c.args[0] === "clone",
      );
      expect(cloneCall?.args).toContain("--branch");
      expect(cloneCall?.args).toContain("v2.0.3");
      expect(cloneCall?.args).toContain("https://github.com/hellodk/champ");

      const esbuildCall = h.calls.find(
        (c) => c.file === "/usr/bin/node" && c.args[0] === "esbuild.mjs",
      );
      expect(esbuildCall?.args).toEqual(["esbuild.mjs", "--production"]);

      const globalInstall = h.calls.find(
        (c) => c.file === "npm" && c.args.includes("--global"),
      );
      expect(globalInstall?.args).toContain("--force");
      expect(globalInstall?.args).toContain("--prefix");
      expect(globalInstall?.args).toContain("/tmp/custom-prefix");
      expect(globalInstall?.args.at(-1)).toMatch(/champ-2\.0\.3\.tgz$/);

      const packCall = h.calls.find(
        (c) => c.file === "npm" && c.args[0] === "pack",
      );
      const packDestination =
        packCall?.args[packCall.args.indexOf("--pack-destination") + 1];
      expect(packDestination && fs.existsSync(packDestination)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("refuses to overwrite a local git checkout unless --force is passed", async () => {
    const h = makeHarness({
      isGitCheckout: true,
      installedCommit: "1111111",
      remoteVersion: "2.0.3",
      remoteSha: "3333333abcdef",
    });
    try {
      const refused = await runUpdateCommand(
        { check: false, force: false },
        h.deps,
      );
      expect(refused).toBe(1);
      expect(h.err.join("")).toContain("local git checkout");

      const forced = await runUpdateCommand(
        { check: false, force: true },
        h.deps,
      );
      expect(forced).toBe(0);
      expect(h.out.join("")).toContain("Updated champ to 2.0.3");
    } finally {
      h.cleanup();
    }
  });

  it("fails gracefully when git is missing, ref is missing, or npm install fails with EACCES", async () => {
    const missingGit = makeHarness({
      execImpl: (call) => {
        if (call.file === "git" && call.args[0] === "--version") {
          throw new Error("spawn git ENOENT");
        }
        return "";
      },
    });
    try {
      const code = await runUpdateCommand(
        { check: false, force: false },
        missingGit.deps,
      );
      expect(code).toBe(1);
      expect(missingGit.err.join("")).toContain("missing required tool 'git'");
    } finally {
      missingGit.cleanup();
    }

    const missingRef = makeHarness({
      execImpl: (call) => {
        if (call.args[0] === "ls-remote") return "";
        return "";
      },
    });
    try {
      const code = await runUpdateCommand(
        { check: false, force: false, ref: "nope" },
        missingRef.deps,
      );
      expect(code).toBe(1);
      expect(missingRef.err.join("")).toContain('ref "nope" not found');
    } finally {
      missingRef.cleanup();
    }

    const eacces = makeHarness({
      installedCommit: "1111111",
      remoteSha: "3333333abcdef",
      execImpl: (call, cloneDir, workDir) => {
        if (call.args[0] === "ls-remote") return "3333333abcdef\tHEAD\n";
        if (call.args[0] === "clone") {
          const target = call.args[call.args.length - 1];
          fs.mkdirSync(target, { recursive: true });
          fs.writeFileSync(
            path.join(target, "package.json"),
            JSON.stringify({ name: "champ", version: "2.0.3" }),
          );
          return "";
        }
        if (call.args[0] === "rev-parse") return "3333333\n";
        if (call.args[0] === "pack") {
          const dest = call.args[call.args.indexOf("--pack-destination") + 1];
          fs.writeFileSync(path.join(dest, "champ-2.0.3.tgz"), "tgz");
          return "";
        }
        if (call.args.includes("--global")) {
          const err = new Error("Command failed") as Error & { stderr: string };
          err.stderr = `EACCES: permission denied in ${cloneDir ?? workDir}`;
          throw err;
        }
        return "";
      },
    });
    try {
      const code = await runUpdateCommand(
        { check: false, force: false },
        eacces.deps,
      );
      expect(code).toBe(1);
      expect(eacces.err.join("")).toContain("global install failed");
      expect(eacces.err.join("")).toContain("--prefix");
    } finally {
      eacces.cleanup();
    }
  });

  it("preserves a custom rootless install prefix inferred from packageRoot", async () => {
    const h = makeHarness({
      installedVersion: "2.0.2",
      installedCommit: "1111111",
      remoteVersion: "2.0.3",
      remoteSha: "4444444abcdef",
    });
    const prefixRoot = path.join(h.root, ".local");
    const installedPkgRoot = path.join(
      prefixRoot,
      "lib",
      "node_modules",
      "champ",
    );
    fs.mkdirSync(installedPkgRoot, { recursive: true });
    fs.copyFileSync(
      path.join(h.pkgRoot, "package.json"),
      path.join(installedPkgRoot, "package.json"),
    );

    try {
      const code = await runUpdateCommand(
        { check: false, force: false },
        { ...h.deps, packageRoot: installedPkgRoot },
      );
      expect(code).toBe(0);
      const installCall = h.calls.find(
        (c) => c.file === "npm" && c.args.includes("--global"),
      );
      expect(installCall?.args).toContain("--prefix");
      expect(installCall?.args).toContain(prefixRoot);
    } finally {
      h.cleanup();
    }
  });
});

describe("released tarball updates", () => {
  function releaseFetch(version: string, assetName?: string) {
    const urls: string[] = [];
    const name = assetName ?? `champ-cli-${version}.tgz`;
    const fetchFn = async (url: string) => {
      urls.push(url);
      if (url.includes("/releases/latest")) {
        return {
          ok: true,
          json: async () => ({
            tag_name: `v${version}`,
            assets: [
              {
                name,
                browser_download_url: `https://example.test/${name}`,
              },
            ],
          }),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      }
      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    };
    return { fetchFn, urls };
  }

  it("recognizes GitHub repository URLs for released updates", () => {
    expect(parseGithubRepo("git+https://github.com/hellodk/champ")).toEqual({
      owner: "hellodk",
      repo: "champ",
    });
    expect(parseGithubRepo("https://example.com/team/champ")).toBeNull();
  });

  it("installs the published CLI tarball instead of rebuilding master", async () => {
    const h = makeHarness({
      installedVersion: "2.0.2",
      installedCommit: "1111111",
    });
    const { fetchFn, urls } = releaseFetch("2.2.0");
    try {
      const code = await runUpdateCommand(
        { check: false, force: false },
        { ...h.deps, fetchFn },
      );
      expect(code).toBe(0);
      expect(h.out.join("")).toContain("Updated champ to 2.2.0 (v2.2.0)");
      expect(urls[0]).toBe(
        "https://api.github.com/repos/hellodk/champ/releases/latest",
      );
      expect(h.calls.some((c) => c.args[0] === "clone")).toBe(false);
      expect(h.calls.some((c) => c.args[0] === "esbuild.mjs")).toBe(false);
      const install = h.calls.find(
        (c) => c.file === "npm" && c.args.includes("--global"),
      );
      expect(install?.args.at(-1)).toMatch(/champ-cli-2\.2\.0\.tgz$/);
    } finally {
      h.cleanup();
    }
  });

  it("reports a stable update from the release without installing", async () => {
    const h = makeHarness({
      installedVersion: "2.0.2",
      installedCommit: "1111111",
    });
    const { fetchFn } = releaseFetch("2.2.0");
    try {
      const code = await runUpdateCommand(
        { check: true, force: false },
        { ...h.deps, fetchFn },
      );
      expect(code).toBe(0);
      expect(h.out.join("")).toContain(
        "Update available: champ 2.0.2 -> 2.2.0 (v2.2.0)",
      );
      expect(
        h.calls.some((c) => c.file === "npm" && c.args.includes("--global")),
      ).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("falls back to building from git when no published asset exists", async () => {
    const h = makeHarness({
      installedVersion: "2.0.2",
      installedCommit: "1111111",
      remoteVersion: "2.0.3",
      remoteSha: "5555555abcdef",
    });
    const fetchFn = async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    try {
      const code = await runUpdateCommand(
        { check: false, force: false },
        { ...h.deps, fetchFn },
      );
      expect(code).toBe(0);
      expect(h.err.join("")).toContain("no published CLI tarball");
      expect(h.calls.some((c) => c.args[0] === "clone")).toBe(true);
      expect(h.out.join("")).toContain("Updated champ to 2.0.3 (5555555)");
    } finally {
      h.cleanup();
    }
  });
});

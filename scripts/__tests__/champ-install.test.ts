import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(__dirname, "..", "..");
const SCRIPT = join(REPO, "scripts", "champ");

let sandbox: string;
let calls: string;
let bashEnv: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "champ-install-test-"));
  calls = join(sandbox, "calls.log");
  bashEnv = join(sandbox, "bash-env.sh");
  writeFileSync(calls, "");

  // Git Bash on Windows prepends its own bin directories to PATH, so PATH-based
  // mocks can be shadowed by a real curl. BASH_ENV functions always win.
  writeFileSync(
    bashEnv,
    [
      `gh() { case "$1" in api) printf 'v9.9.9\\n';; release) printf '%s\\n' 'https://github.com/hellodk/champ/releases/download/v9.9.9/champ-9.9.9.vsix';; esac; }`,
      `curl() { if [ "$1" = "-fL" ]; then p=""; for a in "$@"; do case "$a" in -o*) p="\${a#-o}";; esac; done; [ -n "$p" ] && printf 'MOCKVSIX' > "$p"; fi; return 0; }`,
      `jq() { printf '%s\\n' 'champ-9.9.9.vsix'; }`,
      `code() { printf 'MOCK-CODE args=[%s]\\n' "$*" >> '${bashPath(calls)}'; return 0; }`,
      `pnpm() { return 0; }`,
      `node() { if echo "$*" | grep -q process; then printf '2.0.2\\n'; fi; return 0; }`,
    ].join("\n") + "\n",
  );
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Git Bash needs POSIX-style paths for BASH_ENV and for redirect targets. */
function bashPath(p: string): string {
  if (process.platform !== "win32") return p;
  const normalized = p.replace(/\\/g, "/");
  const drive = normalized.match(/^([A-Za-z]):/);
  return drive
    ? `/${drive[1].toLowerCase()}${normalized.slice(2)}`
    : normalized;
}

function run(mode: "latest" | "build") {
  const out = execFileSync("bash", [SCRIPT, "install", mode], {
    cwd: REPO,
    env: { ...process.env, BASH_ENV: bashPath(bashEnv) },
    encoding: "utf8",
    timeout: 30000,
  });
  return { out };
}

describe("scripts/champ install", () => {
  it("latest mode installs a GitHub release ./champ-*.vsix via code --force", () => {
    const { out } = run("latest");
    const log = readFileSync(calls, "utf8");
    expect(log).toContain(
      "MOCK-CODE args=[--install-extension /tmp/v9.9.9-champ.vsix --force]",
    );
    expect(out).toContain("installed champ v9.9.9");
  });

  it("build mode installs the locally built champ-*.vsix via code --force", () => {
    const { out } = run("build");
    const log = readFileSync(calls, "utf8");
    // bash on Windows reports the POSIX spelling of REPO, so assert the
    // basename rather than a platform-specific absolute path.
    expect(log).toContain("MOCK-CODE args=[--install-extension ");
    expect(log).toContain("champ-2.0.2.vsix --force]");
    expect(out).toContain("installed champ 2.0.2");
  });
});

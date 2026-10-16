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

function logHead() {
  return `printf '%s|' "\${PATH}" >> "${calls}"; command -v code >> "${calls}"; printf '\\n' >> "${calls}";`;
}

function mock(name: string, body: string) {
  writeFileSync(
    join(sandbox, "bin", name),
    `#!/usr/bin/env bash\n${logHead()}${body}`,
  );
  execFileSync("chmod", ["+x", join(sandbox, "bin", name)]);
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "champ-install-test-"));
  calls = join(sandbox, "calls.log");
  mkdirSync(join(sandbox, "bin"));
  writeFileSync(calls, "");

  mock(
    "gh",
    `case "$1" in api) printf 'v9.9.9\\n';; release) printf '%s\\n' '{"assets":[{"url":"https://github.com/hellodk/champ/releases/download/v9.9.9/champ-9.9.9.vsix","name":"champ-9.9.9.vsix"}]}';; esac`,
  );
  mock(
    "curl",
    `if [ "$1" = "-fL" ]; then p=""; for a in "$@"; do case "$a" in -o*) p="\${a#-o}";; esac; done; [ -n "$p" ] && printf 'MOCKVSIX' > "$p"; exit 0; fi; true`,
  );
  mock("jq", `printf '%s\\n' 'champ-9.9.9.vsix'`);
  mock("code", `printf 'MOCK-CODE args=[%s]\\n' "$*" >> "${calls}"; exit 0`);
  mock(
    "node",
    `if echo "$*" | grep -q process; then printf '2.0.2\\n'; fi; exit 0`,
  );
  mock("npm", `exit 0`);
  mock("npx", `exit 0`);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function run(mode: "latest" | "build") {
  const env = {
    ...process.env,
    PATH: join(sandbox, "bin") + ":" + process.env.PATH,
  };
  const out = execFileSync("bash", [SCRIPT, "install", mode], {
    cwd: REPO,
    env,
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
    expect(log).toContain(
      "MOCK-CODE args=[--install-extension " +
        join(REPO, "champ-2.0.2.vsix") +
        " --force]",
    );
    expect(out).toContain("installed champ 2.0.2");
  });
});

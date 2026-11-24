import { spawnSync } from "child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const BASH = "/bin/bash";

async function fakeBin(
  dir: string,
  name: string,
  log: string,
): Promise<string> {
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, name),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`,
    { mode: 0o755 },
  );
  return bin;
}

async function runLint(path: string, env: Record<string, string>) {
  return spawnSync(BASH, ["scripts/champ", "lint"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: path, ...env },
  });
}

describe("unified CLI pnpm resolution (#152)", () => {
  it("falls back to corepack pnpm when pnpm is not on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "champ-corepack-"));
    const log = join(dir, "corepack.log");
    const bin = await fakeBin(dir, "corepack", log);

    const result = await runLint(`${bin}:/usr/bin:/bin`, {
      COREPACK_LOG: log,
    });

    expect(result.status).toBe(0);
    const calls = await readFile(log, "utf8");
    expect(calls).toContain("pnpm run check-types");
    expect(calls).toContain("pnpm run lint");
  });

  it("uses bare pnpm when it is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "champ-pnpm-"));
    const pnpmLog = join(dir, "pnpm.log");
    const corepackLog = join(dir, "corepack.log");
    const bin = await fakeBin(dir, "pnpm", pnpmLog);
    await writeFile(
      join(bin, "corepack"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${corepackLog}"\n`,
      { mode: 0o755 },
    );

    const result = await runLint(`${bin}:/usr/bin:/bin`, {
      COREPACK_LOG: corepackLog,
    });

    expect(result.status).toBe(0);
    expect(await readFile(pnpmLog, "utf8")).toContain("run check-types");
    await expect(readFile(corepackLog, "utf8")).rejects.toThrow();
  });

  it("fails clearly when neither pnpm nor Corepack is available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "champ-no-pnpm-"));
    const bin = join(dir, "bin");
    await mkdir(bin, { recursive: true });

    const result = await runLint(`${bin}:/usr/bin:/bin`, {});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm");
    expect(result.stderr).toContain("corepack");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression guard for issue #103.
 *
 * GitUtils receives LLM-controlled arguments (branch names, file paths,
 * commit messages). Every invocation MUST pass those values as individual
 * argv entries to git directly — never through a shell string that could
 * interpret quotes, backticks or $() substitutions.
 *
 * These tests capture the child_process call and assert the array form.
 */

const execSyncSpy = vi.fn();
vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => execSyncSpy(...args),
  execFileSync: (...args: unknown[]) => execSyncSpy(...args),
}));

import { GitUtils } from "../../../src/tools/git/git-utils";

const ROOT = "/tmp/fake-repo";

/** A captured call is safe iff git received plain argv (no shell wrapper,
 *  no single pre-composed command string containing user data). */
function captures(): unknown[][] {
  return execSyncSpy.mock.calls.map((c) => c);
}

function argvOf(callIndex: number): string[] {
  const call = captures()[callIndex];
  const [cmd, args] = call;
  // execFileSync form: ("git", ["rev-parse", ...]) — safe.
  if (typeof cmd === "string" && Array.isArray(args)) {
    return [cmd, ...(args as string[])];
  }
  // execSync form: one pre-composed shell command string — unsafe by
  // construction (quotes/backticks/$() would be interpreted).
  throw new Error(
    `Expected execFileSync argv form, got shell-style call: ${JSON.stringify(cmd)}`,
  );
}

describe("GitUtils injection safety (#103)", () => {
  beforeEach(() => {
    execSyncSpy.mockReset();
    execSyncSpy.mockReturnValue("");
  });

  it("getCurrentBranch uses array argv without a shell", async () => {
    await GitUtils.getCurrentBranch(ROOT);
    expect(captures().length).toBe(1);
    const argv = argvOf(0);
    expect(argv[0]).toBe("git");
    expect(argv.slice(1)).toEqual(["rev-parse", "--abbrev-ref", "HEAD"]);
  });

  it("getCommitsSinceBranch passes hostile branch name as a single argv entry", async () => {
    const hostile = 'main"; touch /tmp/pwned-103a #';
    await GitUtils.getCommitsSinceBranch(ROOT, hostile);

    expect(captures().length).toBeGreaterThan(0);
    for (let i = 0; i < captures().length; i++) {
      const argv = argvOf(i); // throws if any call was a shell string
      expect(argv).not.toContain("/bin/sh");
      // The branch must appear verbatim as ONE element — never embedded
      // inside a larger command string.
      if (argv.includes(hostile)) {
        expect(argv.filter((a) => a.includes(hostile))).toEqual([hostile]);
      }
    }
    expect(
      captures().some((c) => {
        if (!(typeof c[0] === "string") || !Array.isArray(c[1])) {
          throw new Error("shell-style call detected");
        }
        // Branch appears inside exactly one argv element (the range spec),
        // never spread across a composed command string.
        return (c[1] as string[]).some((a) => a === `${hostile}..HEAD`);
      }),
    ).toBe(true);
  });

  it("stageFiles passes hostile filenames as individual argv entries", async () => {
    const hostileFile = 'a"; $(touch /tmp/pwned-103b) #.ts';
    await GitUtils.stageFiles(ROOT, [hostileFile]);

    expect(captures().length).toBe(1);
    const argv = argvOf(0);
    expect(argv[0]).toBe("git");
    expect(argv[1]).toBe("add");
    expect(argv).toContain(hostileFile);
    // No quoting layers around the filename anywhere in argv
    expect(argv.some((a) => a.includes(`"${hostileFile}"`))).toBe(false);
  });

  it("createCommit passes hostile message verbatim via -m <arg>", async () => {
    const hostileMsg = "fix `rm -rf /tmp/pwned-103c` and $(whoami)";
    execSyncSpy
      .mockImplementationOnce(() => "")
      .mockImplementationOnce(() => "abc123");
    await GitUtils.createCommit(ROOT, hostileMsg);

    const addCallIdx = captures().findIndex((c) => {
      if (!(typeof c[0] === "string") || !Array.isArray(c[1])) {
        throw new Error("shell-string call detected");
      }
      return (c[1] as string[])[0] === "commit";
    });
    expect(addCallIdx).toBeGreaterThanOrEqual(0);
    const argv = argvOf(addCallIdx);
    expect(argv[1]).toBe("commit");
    expect(argv[2]).toBe("-m");
    expect(argv[3]).toBe(hostileMsg);
    expect(argv).toHaveLength(4);
  });

  it("isGitRepository and getRemoteConfig use array argv too", async () => {
    await GitUtils.isGitRepository(ROOT);
    await GitUtils.getRemoteConfig(ROOT);
    expect(captures().length).toBe(2);
    argvOf(0);
    argvOf(1);
  });
});

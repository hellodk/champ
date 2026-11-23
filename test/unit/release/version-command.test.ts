import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "champ");

// The unified CLI is a bash script. Git Bash exists on GitHub Windows runners,
// but skipping there keeps the cross-platform unit matrix deterministic: the
// release workflow itself only runs on ubuntu-latest.
const describePosix = process.platform === "win32" ? describe.skip : describe;

function nextVersion(current: string, latestTag = ""): string {
  return execFileSync("bash", [SCRIPT, "version", "next", current, latestTag], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

describePosix("scripts/champ version next", () => {
  it("bumps the current patch version when there is no release tag", () => {
    expect(nextVersion("2.0.2")).toBe("2.0.3");
  });

  it("bumps the newest tag when the tag is ahead of package.json", () => {
    expect(nextVersion("2.0.2", "v2.1.9")).toBe("2.1.10");
  });

  it("bumps package.json when it is ahead of the newest tag", () => {
    expect(nextVersion("2.1.0", "v2.0.9")).toBe("2.1.1");
  });

  it("accepts tags with and without the v prefix", () => {
    expect(nextVersion("2.0.2", "3.4.5")).toBe("3.4.6");
  });

  it("fails closed on a malformed version", () => {
    expect(() => nextVersion("not-a-version")).toThrow();
  });
});

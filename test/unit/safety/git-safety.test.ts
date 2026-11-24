import { describe, expect, it } from "vitest";
import { checkGitSafety } from "@/safety/git-safety";

describe("git safety guard", () => {
  const blocked = [
    "git reset --hard HEAD~1",
    "git clean -fd",
    "git checkout -- src/a.ts",
    "git checkout -f main",
    "git restore src/a.ts",
    "git stash drop",
    "git stash clear",
    "git branch -D feature",
    "git push --force",
  ];

  for (const command of blocked) {
    it(`blocks ${command}`, () => {
      const result = checkGitSafety(command);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  }

  it("allows safe git and non-git commands", () => {
    for (const command of [
      "git status",
      "git diff",
      "git restore --staged src/a.ts",
      "pnpm exec vitest run",
      "echo 'git reset --hard'",
    ]) {
      expect(checkGitSafety(command).allowed, command).toBe(true);
    }
  });
});

import { describe, it, expect } from "vitest";

function parseArgs(argv: string[]) {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    team: get("--team"),
    task: get("--task"),
    provider: get("--provider") ?? "ollama",
    workspace: get("--workspace") ?? process.cwd(),
  };
}

describe("run-team argument parsing", () => {
  it("parses --team and --task", () => {
    const r = parseArgs(["--team", "devops", "--task", "deploy"]);
    expect(r.team).toBe("devops");
    expect(r.task).toBe("deploy");
  });
  it("defaults provider to ollama", () => {
    expect(parseArgs(["--team", "t", "--task", "x"]).provider).toBe("ollama");
  });
  it("parses --provider claude", () => {
    expect(
      parseArgs(["--team", "t", "--task", "x", "--provider", "claude"])
        .provider,
    ).toBe("claude");
  });
  it("returns undefined for missing team", () => {
    expect(parseArgs(["--task", "x"]).team).toBeUndefined();
  });
  it("parses --workspace", () => {
    expect(
      parseArgs([
        "--team",
        "t",
        "--task",
        "x",
        "--workspace",
        "/home/user/proj",
      ]).workspace,
    ).toBe("/home/user/proj");
  });
});

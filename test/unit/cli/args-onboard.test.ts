import { describe, expect, it } from "vitest";
import { parseCliArgs, USAGE } from "@/cli/args";

describe("cli onboard argument parsing", () => {
  it("parses provider onboard URL, key and name flags", () => {
    const result = parseCliArgs(
      [
        "provider",
        "onboard",
        "https://api.example.com/v1",
        "--api-key",
        "secret-from-flag",
        "--endpoint",
        "my-endpoint",
      ],
      { stdinIsTTY: true, cwd: "/tmp/ws" },
    );
    expect(result.kind).toBe("provider-command");
    expect(result).toMatchObject({
      command: {
        name: "provider-onboard",
        url: "https://api.example.com/v1",
        apiKey: "secret-from-flag",
        endpointName: "my-endpoint",
      },
    });
  });

  it("parses model smart, scope and pool commands", () => {
    const smart = parseCliArgs(["model", "smart", "--preference", "quality"], {
      stdinIsTTY: true,
      cwd: "/tmp/ws",
    });
    expect(smart).toMatchObject({
      command: { name: "model-smart", preference: "quality" },
    });

    const scope = parseCliArgs(["model", "scope", "global", "--allow-cloud"], {
      stdinIsTTY: true,
      cwd: "/tmp/ws",
    });
    expect(scope).toMatchObject({
      command: { name: "model-scope", scope: "global", allowCloud: true },
    });

    const pool = parseCliArgs(["model", "pool", "add", "Local", "ep_a,ep_b"], {
      stdinIsTTY: true,
      cwd: "/tmp/ws",
    });
    expect(pool).toMatchObject({
      command: {
        name: "model-pool-add",
        poolName: "Local",
        endpointIds: ["ep_a", "ep_b"],
      },
    });
  });

  it("parses --details for the model list", () => {
    const result = parseCliArgs(["models", "--details"], {
      stdinIsTTY: true,
      cwd: "/tmp/ws",
    });
    expect(result).toMatchObject({
      command: { name: "models", details: true },
    });
  });

  it("parses model failover with a retry budget", () => {
    const result = parseCliArgs(
      ["model", "failover", "on", "--max-attempts", "2"],
      { stdinIsTTY: true, cwd: "/tmp/ws" },
    );
    expect(result).toMatchObject({
      command: {
        name: "model-failover",
        enabled: true,
        maxAttempts: 2,
      },
    });

    const invalid = parseCliArgs(
      ["model", "failover", "on", "--max-attempts", "9"],
      { stdinIsTTY: true, cwd: "/tmp/ws" },
    );
    expect(invalid.kind).toBe("error");
  });

  it("documents the onboard command in USAGE", () => {
    expect(USAGE).toContain("champ provider onboard <url>");
  });
});

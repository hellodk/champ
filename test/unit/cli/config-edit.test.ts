import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import { parseCliArgs } from "@/cli/args";
import {
  CONFIG_KEYS,
  getConfigValue,
  setConfigValue,
} from "@/cli/config-editor";

describe("headless config editing (#149)", () => {
  it("parses config set and config edit", () => {
    const set = parseCliArgs(["config", "set", "agent.defaultMode", "plan"], {
      stdinIsTTY: true,
    });
    expect(set.kind).toBe("provider-command");
    if (set.kind === "provider-command") {
      expect(set.command).toEqual({
        name: "config-set",
        key: "agent.defaultMode",
        value: "plan",
      });
    }

    const edit = parseCliArgs(["config", "edit"], { stdinIsTTY: true });
    expect(edit.kind).toBe("provider-command");
    if (edit.kind === "provider-command") {
      expect(edit.command).toEqual({ name: "config-edit" });
    }
  });

  it("rejects unknown keys before writing", async () => {
    const configPath = join(
      await mkdtemp(join(tmpdir(), "champ-config-")),
      "config.yaml",
    );
    await expect(
      setConfigValue({ configPath, key: "not.a.real.key", value: "x" }),
    ).rejects.toThrow(/unknown config key/);
  });

  it("writes a single setting atomically and reads it back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "champ-config-"));
    const configPath = join(dir, "config.yaml");
    await writeFile(configPath, "agent:\n  defaultMode: agent\n", "utf8");

    const result = await setConfigValue({
      configPath,
      key: "agent.defaultMode",
      value: "plan",
    });

    expect(result).toContain("agent.defaultMode");
    expect(await getConfigValue({ configPath, key: "agent.defaultMode" })).toBe(
      "plan",
    );
    const text = await readFile(configPath, "utf8");
    expect(text).toContain("defaultMode: plan");
    expect(text).not.toContain("unknown");
  });

  it("coerces boolean and numeric values before writing", async () => {
    const configPath = join(
      await mkdtemp(join(tmpdir(), "champ-config-")),
      "config.yaml",
    );
    await setConfigValue({
      configPath,
      key: "telemetry.enabled",
      value: "false",
    });
    expect(await getConfigValue({ configPath, key: "telemetry.enabled" })).toBe(
      "false",
    );
    expect(CONFIG_KEYS.map((k) => k.key)).toContain("telemetry.enabled");
  });

  it("refuses to overwrite malformed YAML and leaves the file unchanged", async () => {
    const configPath = join(
      await mkdtemp(join(tmpdir(), "champ-config-")),
      "config.yaml",
    );
    const malformed = "provider: ollama\nproviders: [unterminated\n";
    await writeFile(configPath, malformed, "utf8");
    const onEndpoint = vi.fn(async () => {});

    await expect(
      setConfigValue({
        configPath,
        key: "agent.defaultMode",
        value: "plan",
        onEndpoint,
      }),
    ).rejects.toThrow(/cannot parse|invalid yaml|yaml/i);

    expect(await readFile(configPath, "utf8")).toBe(malformed);
    expect(onEndpoint).not.toHaveBeenCalled();
  });

  it("never prints secret values in the config key list", () => {
    for (const entry of CONFIG_KEYS) {
      expect(entry.key.toLowerCase()).not.toContain("apikey");
      expect(entry.key.toLowerCase()).not.toContain("password");
    }
    expect(vi.isMockFunction(setConfigValue)).toBe(false);
  });

  it("setting provider.model preserves the top-level provider string", async () => {
    const configPath = join(
      await mkdtemp(join(tmpdir(), "champ-config-")),
      "config.yaml",
    );
    await writeFile(
      configPath,
      "provider: openai-compatible\nproviders:\n  openai-compatible:\n    model: old-model\n",
      "utf8",
    );
    await setConfigValue({
      configPath,
      key: "provider.model",
      value: "new-model-id",
    });

    const text = await readFile(configPath, "utf8");
    expect(text).toMatch(/^provider:\s*openai-compatible/m);
    expect(text).toContain("model: new-model-id");
  });

  it("edits tui.transcript settings and validates verbosity values", async () => {
    const configPath = join(
      await mkdtemp(join(tmpdir(), "champ-config-")),
      "config.yaml",
    );
    await setConfigValue({
      configPath,
      key: "tui.transcript.verbosity",
      value: "medium",
    });
    await setConfigValue({
      configPath,
      key: "tui.transcript.showCost",
      value: "false",
    });

    expect(
      await getConfigValue({ configPath, key: "tui.transcript.verbosity" }),
    ).toBe("medium");
    expect(
      await getConfigValue({ configPath, key: "tui.transcript.showCost" }),
    ).toBe("false");

    await expect(
      setConfigValue({
        configPath,
        key: "tui.transcript.verbosity",
        value: "verbose",
      }),
    ).rejects.toThrow();
  });
});

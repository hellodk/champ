import { describe, expect, it } from "vitest";

import { canonicalChatCommand, commandSuggestions } from "@/cli/commands";

describe("shared slash-command suggestions (#151)", () => {
  it("resolves /models to the canonical /model command", () => {
    expect(canonicalChatCommand("/models")).toBe("/model");
    expect(canonicalChatCommand("/status")).toBe("/status");
    expect(canonicalChatCommand("plain text")).toBeNull();
  });

  it("filters built-ins by prefix and merges skills without duplicates", () => {
    const suggestions = commandSuggestions("mod", [
      { name: "/model", description: "skill duplicate" },
      { name: "/explain", description: "explain code" },
    ]);
    const names = suggestions.map((s) => s.name);
    expect(names).toContain("/model");
    expect(names).toContain("/models");
    expect(names).not.toContain("/explain");
    expect(names.filter((name) => name === "/model")).toHaveLength(1);
  });

  it("returns built-ins and skills for an empty prefix", () => {
    const suggestions = commandSuggestions("", [
      { name: "/explain", description: "explain code" },
    ]);
    expect(suggestions.map((s) => s.name)).toContain("/help");
    expect(suggestions.map((s) => s.name)).toContain("/explain");
  });
});

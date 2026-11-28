import { describe, expect, it } from "vitest";
import type { CommandSuggestion } from "@/cli/commands";
import {
  buildPaletteActions,
  filterPaletteActions,
  fuzzyScore,
} from "@/tui/palette";

const screens = [
  { id: "chat", label: "Chat" },
  { id: "sessions", label: "Sessions" },
  { id: "usage", label: "Usage" },
] as const;

const slash: CommandSuggestion[] = [
  { name: "/checkpoint", description: "mark a context checkpoint" },
  { name: "/compact", description: "compact at the newest checkpoint" },
  { name: "/sessions", description: "list workspace sessions" },
];

describe("command palette", () => {
  const actions = buildPaletteActions(screens, slash);

  it("matches non-contiguous query characters", () => {
    expect(fuzzyScore("usg", "Usage")).toBeGreaterThan(0);
    expect(fuzzyScore("usg", "Providers")).toBeNull();
  });

  it("ranks exact prefix matches first", () => {
    const ranked = filterPaletteActions(actions, "ses");
    expect(ranked[0].id).toBe("screen:sessions");
  });

  it("searches descriptions as well as labels", () => {
    const ranked = filterPaletteActions(actions, "compact");
    expect(ranked.some((action) => action.id === "command:/compact")).toBe(
      true,
    );
  });

  it("returns every action for an empty query in stable order", () => {
    expect(filterPaletteActions(actions, "")).toEqual(actions);
  });
});

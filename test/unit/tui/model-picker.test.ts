import { describe, expect, it } from "vitest";
import { filterModels, modelLabel } from "@/tui/model-picker";

const models = [
  "mlx-community/Qwen3.5-4B-MLX-4bit",
  "mlx-community/gemma-4-e2b-it-4bit",
  "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
];

describe("TUI model picker", () => {
  it("filters by fuzzy subsequence", () => {
    expect(filterModels(models, "q25")).toEqual([
      "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    ]);
    expect(filterModels(models, "gemma")).toEqual([
      "mlx-community/gemma-4-e2b-it-4bit",
    ]);
  });

  it("keeps the full id visible and highlights the short name", () => {
    expect(modelLabel(models[2])).toBe("Qwen2.5-0.5B-Instruct-4bit");
    expect(modelLabel("/cache/models--Qwen--snapshot")).toBe(
      "models--Qwen--snapshot",
    );
  });
});

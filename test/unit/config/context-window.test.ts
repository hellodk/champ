import { describe, expect, it } from "vitest";
import {
  extractNumCtxFromParameters,
  parseNumCtxFromGrepLine,
  resolveEffectiveContextWindow,
} from "@/config/context-window";

describe("parseNumCtxFromGrepLine (#119)", () => {
  it("parses a raw modelfile num_ctx line", () => {
    expect(parseNumCtxFromGrepLine("num_ctx           32768")).toBe(32768);
  });

  it("parses a parameters string line", () => {
    expect(parseNumCtxFromGrepLine("num_ctx 16384")).toBe(16384);
  });

  it("parses a tool call in a single line", () => {
    expect(parseNumCtxFromGrepLine('num_ctx 8192 "stop"')).toBe(8192);
  });

  it("returns undefined for unrelated content", () => {
    expect(parseNumCtxFromGrepLine("temperature 0.7")).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(parseNumCtxFromGrepLine("")).toBeUndefined();
  });
});

describe("extractNumCtxFromParameters (#119)", () => {
  it("extracts from a multi-line parameters string", () => {
    const parameters = 'stop "<|start_header_id|>"\nnum_ctx 65536\nnum_gpu 99';
    expect(extractNumCtxFromParameters(parameters)).toBe(65536);
  });

  it("extracts from a single-line modelfile", () => {
    expect(extractNumCtxFromParameters("FROM llama3.1\nnum_ctx 24576")).toBe(
      24576,
    );
  });

  it("returns undefined when num_ctx is absent", () => {
    expect(extractNumCtxFromParameters("temperature 0.7")).toBeUndefined();
  });
});

describe("resolveEffectiveContextWindow (#119)", () => {
  it("prioritises the runtime num_ctx parameter over metadata", () => {
    expect(
      resolveEffectiveContextWindow({
        numCtxParam: 2048,
        modelInfoContextLength: 8192,
        fallback: 8192,
      }),
    ).toBe(2048);
  });

  it("falls back to model_info context_length when no num_ctx", () => {
    expect(
      resolveEffectiveContextWindow({
        modelInfoContextLength: 16384,
        fallback: 8192,
      }),
    ).toBe(16384);
  });

  it("applies capWindow when present", () => {
    expect(
      resolveEffectiveContextWindow({
        numCtxParam: 65536,
        modelInfoContextLength: 8192,
        capWindow: 32768,
        fallback: 8192,
      }),
    ).toBe(32768);
  });

  it("does not let capWindow raise the window", () => {
    expect(
      resolveEffectiveContextWindow({
        modelInfoContextLength: 4096,
        capWindow: 16384,
        fallback: 8192,
      }),
    ).toBe(4096);
  });

  it("uses the fallback when nothing is detected", () => {
    expect(resolveEffectiveContextWindow({ fallback: 8192 })).toBe(8192);
  });

  it("returns a minimum of 1 for degenerate zero values", () => {
    expect(resolveEffectiveContextWindow({ numCtxParam: 0, fallback: 1 })).toBe(
      1,
    );
  });
});

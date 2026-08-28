import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILES,
  mergeEffectiveDecode,
  resolveProfile,
  type DecodeTask,
} from "@/config/decode-profile";

describe("default decode profiles (#120)", () => {
  it("every task class has a profile", () => {
    const tasks: DecodeTask[] = [
      "coding",
      "chat",
      "completion",
      "toolcall",
      "embedding",
    ];
    for (const t of tasks) {
      expect(resolveProfile(t)).toBeDefined();
    }
  });

  it("toolcall is deterministic (low temperature, fixed seed)", () => {
    const p = resolveProfile("toolcall");
    expect(p.temperature).toBeLessThanOrEqual(0.2);
    expect(p.seed).toBeDefined();
  });

  it("autocomplete (completion) is deterministic", () => {
    const p = resolveProfile("completion");
    expect(p.temperature).toBeLessThanOrEqual(0.3);
  });

  it("chat keeps the historical 0.7 default", () => {
    expect(resolveProfile("chat").temperature).toBe(0.7);
  });

  it("coding is tighter than chat with a top-p of 0.95", () => {
    const p = resolveProfile("coding");
    expect(p.temperature).toBeLessThan(0.7);
    expect(p.topP).toBe(0.95);
  });

  it("embedding has no decode parameters", () => {
    expect(Object.keys(resolveProfile("embedding")).length).toBe(0);
  });
});

describe("mergeEffectiveDecode precedence (#120)", () => {
  it("explicit per-request override beats config options and profile", () => {
    const r = mergeEffectiveDecode({
      explicit: { temperature: 0.1 },
      configOptions: { temperature: 0.9, topP: 0.5 },
      taskHint: "toolcall",
    });
    expect(r.temperature).toBe(0.1);
  });

  it("config options win over the task profile", () => {
    const r = mergeEffectiveDecode({
      configOptions: { temperature: 0.9 },
      taskHint: "toolcall",
    });
    expect(r.temperature).toBe(0.9);
  });

  it("the task profile fills fields the user did not pin", () => {
    const r = mergeEffectiveDecode({
      configOptions: { topP: 0.5 },
      taskHint: "toolcall",
    });
    expect(r.temperature).toBe(DEFAULT_PROFILES.toolcall.temperature);
    expect(r.seed).toBe(DEFAULT_PROFILES.toolcall.seed);
    expect(r.topP).toBe(0.5);
  });

  it("no hint and no config keeps the built-in temperature when supplied", () => {
    const r = mergeEffectiveDecode({
      configOptions: { temperature: 0.7 },
    });
    expect(r.temperature).toBe(0.7);
  });

  it("no layers at all yields an empty set (server defaults)", () => {
    expect(Object.keys(mergeEffectiveDecode({})).length).toBe(0);
  });

  it("zero is honoured as an explicit value", () => {
    const r = mergeEffectiveDecode({
      explicit: { temperature: 0 },
      configOptions: { temperature: 0.9 },
      taskHint: "coding",
    });
    expect(r.temperature).toBe(0);
  });

  it("stop arrays flow through the layers", () => {
    const r = mergeEffectiveDecode({
      explicit: { stop: ["END"] },
      taskHint: "chat",
    });
    expect(r.stop).toEqual(["END"]);
  });
});

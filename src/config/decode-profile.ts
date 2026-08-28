/**
 * Task-aware decode profiles (ticket #120).
 *
 * Today every request runs at a fixed temperature 0.7. These profiles pick
 * sane defaults per task class, so tool calls are deterministic and code
 * generation runs tighter than creative chat.
 *
 * Effective-parameter precedence for a request (highest first):
 *   1. explicit per-request options (passed to chat()/complete())
 *   2. the provider's YAML `options:` block       (config-provider overrides)
 *   3. the task decode profile                    (this module)
 *   4. built-in provider config defaults          (LLMProviderConfig fields)
 *
 * Note: this deliberately swaps tiers 2 and 3 relative to the first draft
 * of the plan — a user who pins a value in YAML expects it to hold, so their
 * overrides beat the automatic task profile.
 */
import type { DecodeParams, TaskHint } from "../providers/types";

export type DecodeTask = TaskHint;

export const DEFAULT_PROFILES: Record<DecodeTask, DecodeParams> = {
  toolcall: { temperature: 0.2, topP: 0.9, seed: 42 },
  coding: { temperature: 0.3, topP: 0.95, topK: 40, repeatPenalty: 1.1 },
  chat: { temperature: 0.7, topP: 0.9 },
  completion: { temperature: 0.2, topP: 0.9, seed: 42 },
  embedding: {},
};

const DECODE_KEYS: (keyof DecodeParams)[] = [
  "temperature",
  "topP",
  "topK",
  "minP",
  "repeatPenalty",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
  "stop",
];

/** The profile for a task class, or an empty set when no hint is given. */
export function resolveProfile(taskHint?: DecodeTask): DecodeParams {
  return taskHint ? DEFAULT_PROFILES[taskHint] : {};
}

export interface MergeDecodeInput {
  /** Options passed directly to the request (highest priority). */
  explicit?: DecodeParams;
  /** The provider's YAML `options:` block (user overrides). */
  configOptions?: DecodeParams;
  /** Task class whose profile fills gaps left by the upper layers. */
  taskHint?: DecodeTask;
  /** Built-in provider config defaults (lowest priority, legacy settings). */
  base?: DecodeParams;
}

/**
 * Merge the layers into the effective decode parameters for a request.
 * Later layers fill only the fields the higher-priority layers left
 * undefined.
 */
export function mergeEffectiveDecode({
  explicit = {},
  configOptions = {},
  taskHint,
  base = {},
}: MergeDecodeInput): DecodeParams {
  const profile = resolveProfile(taskHint);
  const result: DecodeParams = {};
  for (const key of DECODE_KEYS) {
    const value =
      explicit[key] ?? configOptions[key] ?? profile[key] ?? base[key];
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

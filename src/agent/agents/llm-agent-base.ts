/**
 * Shared helpers for agents that call an LLM and parse a JSON response.
 *
 * The agents all follow the same pattern:
 *   1. Build a prompt from the user request + upstream agent outputs
 *   2. Stream the LLM response
 *   3. Parse structured JSON from the text
 *   4. Return an AgentOutput
 *
 * This module centralizes the LLM call and JSON extraction so each
 * specialized agent only has to define its prompt and its output shape.
 */
import type { LLMProvider, LLMMessage } from "../../providers/types";

export interface StreamResult {
  text: string;
  error?: string;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Stream an LLM chat response and accumulate it into a single string.
 * Returns the full text, any error, and real token usage from the done delta.
 */
export async function streamToString(
  provider: LLMProvider,
  messages: LLMMessage[],
  onChunk?: (text: string) => void,
  chatOptions?: import("../../providers/types").ChatOptions,
): Promise<StreamResult> {
  let text = "";
  let error: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const delta of provider.chat(messages, chatOptions)) {
    if (delta.type === "text" && delta.text) {
      text += delta.text;
      onChunk?.(delta.text);
    } else if (delta.type === "error") {
      error = delta.error;
    } else if (delta.type === "done") {
      if (delta.usage) {
        inputTokens = delta.usage.inputTokens ?? 0;
        outputTokens = delta.usage.outputTokens ?? 0;
      }
      break;
    }
  }

  return { text, error, usage: { inputTokens, outputTokens } };
}

/**
 * Extract the first JSON object or array from a string that may contain
 * additional prose. Returns null if no valid JSON is found.
 */
export function extractJson<T>(text: string): T | null {
  // Try direct parse first.
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through to substring extraction.
  }

  // Find the first {...} or [...] balanced block.
  const firstBrace = text.search(/[{[]/);
  if (firstBrace === -1) return null;

  const opener = text[firstBrace];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"' && !escape) {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(firstBrace, i + 1);
        try {
          return JSON.parse(candidate) as T;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

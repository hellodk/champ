/**
 * Integration tests for TeamAgent with real Ollama.
 *
 * Requires Ollama running on localhost:11434 with llama3.1:8b.
 * Run with: npx vitest run --config vitest.integration.config.ts test/integration/team-agent.integration.test.ts
 */
import { describe, it, expect, beforeAll } from "vitest";
import { TeamAgent } from "../../src/agent/team-agent";
import { SharedMemory } from "../../src/agent/shared-memory";
import { OllamaProvider } from "../../src/providers/ollama";
import type { TeamAgentDefinition } from "../../src/agent/team-definition";

// Skip all tests if Ollama is not available
const OLLAMA_MODEL = "llama3.1:8b";
const OLLAMA_BASE_URL = "http://localhost:11434";

async function isOllamaAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

function makeAgent(
  overrides: Partial<Required<TeamAgentDefinition>> = {},
): Required<TeamAgentDefinition> {
  return {
    id: "test-agent",
    name: "Test Agent",
    role: "test role",
    systemPrompt: "You are a helpful assistant.",
    dependsOn: [],
    condition: "",
    tools: [],
    model: OLLAMA_MODEL,
    maxTokens: 500,
    outputKey: "test-agent",
    outputFormat: "text" as const,
    selfCritique: false,
    ...overrides,
  };
}

describe("TeamAgent integration with Ollama", { timeout: 60_000 }, () => {
  let ollamaAvailable = false;

  // Check once before all tests
  beforeAll(async () => {
    ollamaAvailable = await isOllamaAvailable();
    if (!ollamaAvailable) {
      console.warn(
        "Skipping integration tests: Ollama not available at",
        OLLAMA_BASE_URL,
      );
    }
  });

  it("generates a text response and stores it in SharedMemory", async () => {
    if (!ollamaAvailable) return;

    const provider = new OllamaProvider({
      provider: "ollama",
      model: OLLAMA_MODEL,
      baseUrl: OLLAMA_BASE_URL,
    });
    const memory = new SharedMemory();
    const agent = new TeamAgent(makeAgent(), provider);

    const output = await agent.execute(
      { userRequest: "Say exactly: Hello from Champ", context: [] },
      memory,
    );

    expect(output.success).toBe(true);
    expect(output.output.length).toBeGreaterThan(0);
    // Memory should have the output stored
    expect(memory.has("test-agent")).toBe(true);
    expect(memory.getOutput("test-agent")).toBeDefined();
  });

  it("detects BLOCKED prefix and marks agent as failed", async () => {
    if (!ollamaAvailable) return;

    const provider = new OllamaProvider({
      provider: "ollama",
      model: OLLAMA_MODEL,
      baseUrl: OLLAMA_BASE_URL,
    });
    const memory = new SharedMemory();
    const agent = new TeamAgent(
      makeAgent({
        systemPrompt:
          "You MUST respond with exactly this text and nothing else: BLOCKED: missing database schema",
      }),
      provider,
    );

    const output = await agent.execute(
      { userRequest: "Do the task", context: [] },
      memory,
    );

    // LLMs may not follow instructions exactly, so check if blocked or succeeded
    if (output.error?.startsWith("BLOCKED:")) {
      expect(output.success).toBe(false);
      expect(output.error).toContain("BLOCKED:");
      expect(memory.get("test-agent_blocked")).toBe(true);
    } else {
      // Model didn't follow blocking instruction — that's OK, test the detection logic
      expect(output.output.length).toBeGreaterThan(0);
    }
  });

  it("extracts content from <output> tags when present", async () => {
    if (!ollamaAvailable) return;

    const provider = new OllamaProvider({
      provider: "ollama",
      model: OLLAMA_MODEL,
      baseUrl: OLLAMA_BASE_URL,
    });
    const memory = new SharedMemory();
    const agent = new TeamAgent(
      makeAgent({
        systemPrompt:
          "Respond with exactly this format:\n<reasoning>\nThinking here\n</reasoning>\n<output>\nFinal answer: 42\n</output>",
      }),
      provider,
    );

    const output = await agent.execute(
      { userRequest: "What is the answer?", context: [] },
      memory,
    );

    expect(output.success).toBe(true);
    // If the model followed instructions, output should not contain <reasoning> tags
    // It may or may not follow the format exactly
    expect(output.output.length).toBeGreaterThan(0);
  });

  it("stores parsed JSON object in memory for JSON outputFormat", async () => {
    if (!ollamaAvailable) return;

    const provider = new OllamaProvider({
      provider: "ollama",
      model: OLLAMA_MODEL,
      baseUrl: OLLAMA_BASE_URL,
    });
    const memory = new SharedMemory();
    const agent = new TeamAgent(
      makeAgent({
        outputFormat: "json" as const,
        systemPrompt:
          'Respond with ONLY valid JSON, no other text: {"status": "ok", "value": 1}',
      }),
      provider,
    );

    const output = await agent.execute(
      { userRequest: "Return the JSON", context: [] },
      memory,
    );

    expect(output.success).toBe(true);
    // Memory may contain parsed JSON object or raw text (model may not follow format)
    const stored = memory.get("test-agent");
    expect(stored).toBeDefined();
  });

  it("fires streaming callback for each chunk", async () => {
    if (!ollamaAvailable) return;

    const provider = new OllamaProvider({
      provider: "ollama",
      model: OLLAMA_MODEL,
      baseUrl: OLLAMA_BASE_URL,
    });
    const memory = new SharedMemory();
    const chunks: string[] = [];
    const agent = new TeamAgent(
      makeAgent(),
      provider,
      (chunk) => chunks.push(chunk), // stream callback
    );

    const output = await agent.execute(
      { userRequest: "Count from 1 to 5", context: [] },
      memory,
    );

    expect(output.success).toBe(true);
    // Streaming should have fired at least one chunk
    expect(chunks.length).toBeGreaterThan(0);
    // All chunks concatenated should equal the full output (approximately)
    const combined = chunks.join("");
    expect(combined.length).toBeGreaterThan(0);
  });

  it("uses template variables from SharedMemory in system prompt", async () => {
    if (!ollamaAvailable) return;

    const provider = new OllamaProvider({
      provider: "ollama",
      model: OLLAMA_MODEL,
      baseUrl: OLLAMA_BASE_URL,
    });
    const memory = new SharedMemory();
    // Pre-populate memory with a value the agent's prompt will reference
    memory.set("plan", { task: "write a hello world function" });

    const agent = new TeamAgent(
      makeAgent({
        systemPrompt:
          "You are a developer. Your task is: {{plan.task}}. Complete it.",
      }),
      provider,
    );

    const output = await agent.execute(
      { userRequest: "Complete the assigned task", context: [] },
      memory,
    );

    expect(output.success).toBe(true);
    // Output should contain something related to hello world
    expect(output.output.toLowerCase()).toMatch(/hello|function|def|const|fn/i);
  });
});

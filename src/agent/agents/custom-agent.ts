import type { LLMProvider } from "../../providers/types";
import { streamToString, extractJson } from "./llm-agent-base";
import type { Agent, AgentInput, AgentOutput, SharedMemory } from "./types";

export interface CustomAgentDefinition {
  name: string;
  role: string;
  systemPrompt: string;
  outputKey?: string;
}

export class CustomAgent implements Agent {
  constructor(
    private readonly def: CustomAgentDefinition,
    private readonly provider: LLMProvider,
  ) {}

  get name(): string {
    return this.def.name;
  }
  get role(): string {
    return this.def.role;
  }

  async execute(input: AgentInput, memory: SharedMemory): Promise<AgentOutput> {
    const contextText = input.context
      .map((c) => `// ${c.filePath}:${c.startLine}-${c.endLine}\n${c.text}`)
      .join("\n\n---\n\n");
    const userContent = contextText
      ? `${input.userRequest}\n\n${contextText}`
      : input.userRequest;

    const { text, error } = await streamToString(this.provider, [
      { role: "system", content: this.def.systemPrompt },
      { role: "user", content: userContent },
    ]);

    const parsed = extractJson<{ passed?: boolean; approved?: boolean }>(text);
    const output: AgentOutput = {
      success: !error,
      output: error ? `Error: ${error}` : text,
      error: error || undefined,
      passed: parsed?.passed,
      approved: parsed?.approved,
    };

    const key = this.def.outputKey ?? this.def.name;
    memory.setOutput(key, output);
    return output;
  }
}

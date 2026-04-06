/**
 * PlannerAgent: breaks a user request into a structured execution plan.
 *
 * Output shape: { steps: [{ step, description, targetFiles, actionType }] }
 * Downstream agents (Context, Code) read this plan from SharedMemory to
 * know what files to load and what changes to generate.
 */
import type { LLMProvider, LLMMessage } from "../../providers/types";
import type {
  Agent,
  AgentInput,
  AgentOutput,
  SharedMemory,
  Plan,
} from "./types";
import { streamToString, extractJson } from "./llm-agent-base";

const PLANNER_SYSTEM_PROMPT = `You are the Planner Agent. Your role is to break down the user's request into a structured execution plan.

Output ONLY a JSON object in this exact format:
{
  "steps": [
    {
      "step": 1,
      "description": "Read and analyze main.ts",
      "targetFiles": ["src/main.ts"],
      "actionType": "read"
    },
    {
      "step": 2,
      "description": "Apply the bug fix",
      "targetFiles": ["src/main.ts"],
      "actionType": "write"
    }
  ]
}

Valid actionType values: "read", "write", "search", "run", "test".
Do NOT generate code. Do NOT add explanation text outside the JSON.`;

export class PlannerAgent implements Agent {
  readonly name = "planner";
  readonly role = "breaks user requests into structured execution plans";

  constructor(private readonly provider: LLMProvider) {}

  async execute(input: AgentInput, memory: SharedMemory): Promise<AgentOutput> {
    const messages: LLMMessage[] = [
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      {
        role: "user",
        content: `User request: ${input.userRequest}\n\nContext: ${
          input.context.length > 0
            ? input.context
                .map((c) => `${c.filePath}:${c.startLine}-${c.endLine}`)
                .join(", ")
            : "none"
        }`,
      },
    ];

    const { text, error } = await streamToString(this.provider, messages);
    if (error) {
      const failure: AgentOutput = {
        success: false,
        output: "Planner LLM call failed",
        error,
      };
      memory.setOutput(this.name, failure);
      return failure;
    }

    const parsed = extractJson<Plan>(text);
    if (!parsed || !Array.isArray(parsed.steps)) {
      const failure: AgentOutput = {
        success: false,
        output: "Planner returned invalid JSON",
        error: `Could not parse plan from: ${text.slice(0, 200)}`,
      };
      memory.setOutput(this.name, failure);
      return failure;
    }

    const result: AgentOutput = {
      success: true,
      output: `Plan created with ${parsed.steps.length} steps`,
      plan: parsed,
    };
    memory.setOutput(this.name, result);
    return result;
  }
}

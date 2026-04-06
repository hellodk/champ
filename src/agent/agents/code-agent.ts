/**
 * CodeAgent: generates code changes as diffs based on a plan and context.
 *
 * Reads the Planner's output and ContextAgent's chunks from SharedMemory,
 * prompts the LLM for a structured list of diffs, and returns them.
 */
import type { LLMProvider, LLMMessage } from "../../providers/types";
import type {
  Agent,
  AgentInput,
  AgentOutput,
  SharedMemory,
  Diff,
  Plan,
  PlanStep,
  ContextChunk,
} from "./types";
import { streamToString, extractJson } from "./llm-agent-base";

const CODE_SYSTEM_PROMPT = `You are the Code Agent. You receive an execution plan and relevant context chunks. Your role is to generate precise code changes as diffs.

Output ONLY a JSON object in this exact format:
{
  "diffs": [
    {
      "filePath": "src/main.ts",
      "oldContent": "const x = null;",
      "newContent": "const x = getDefault();"
    }
  ]
}

Guidelines:
- Keep changes minimal and focused on the plan.
- oldContent must match the file exactly (including whitespace).
- oldContent must be unique within the file — include enough surrounding lines to disambiguate.
- Follow the project's existing patterns and style.
- Do NOT add explanation text outside the JSON.`;

export class CodeAgent implements Agent {
  readonly name = "code";
  readonly role = "generates code changes as diffs";

  constructor(private readonly provider: LLMProvider) {}

  async execute(input: AgentInput, memory: SharedMemory): Promise<AgentOutput> {
    const plannerOutput = memory.getOutput("planner");
    const contextOutput = memory.getOutput("context");

    const plan = plannerOutput?.plan as Plan | PlanStep[] | undefined;
    const chunks = (contextOutput?.chunks ?? input.context) as ContextChunk[];

    const planSummary = this.formatPlan(plan);
    const contextSummary = chunks
      .map(
        (c) => `=== ${c.filePath}:${c.startLine}-${c.endLine} ===\n${c.text}`,
      )
      .join("\n\n");

    const messages: LLMMessage[] = [
      { role: "system", content: CODE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `User request: ${input.userRequest}\n\nPlan:\n${planSummary}\n\nContext:\n${contextSummary || "none"}`,
      },
    ];

    const { text, error } = await streamToString(this.provider, messages);
    if (error) {
      const failure: AgentOutput = {
        success: false,
        output: "Code LLM call failed",
        error,
      };
      memory.setOutput(this.name, failure);
      return failure;
    }

    const parsed = extractJson<{ diffs: Diff[] }>(text);
    if (!parsed || !Array.isArray(parsed.diffs)) {
      const failure: AgentOutput = {
        success: false,
        output: "Code agent returned invalid JSON",
        error: `Could not parse diffs from: ${text.slice(0, 200)}`,
      };
      memory.setOutput(this.name, failure);
      return failure;
    }

    const result: AgentOutput = {
      success: true,
      output: `Generated ${parsed.diffs.length} file edit(s)`,
      diffs: parsed.diffs,
    };
    memory.setOutput(this.name, result);
    return result;
  }

  private formatPlan(plan: Plan | PlanStep[] | undefined): string {
    if (!plan) return "no plan";
    const steps = Array.isArray(plan) ? plan : plan.steps;
    return steps
      .map(
        (s) =>
          `  ${s.step}. ${s.description}${
            s.targetFiles?.length ? ` (${s.targetFiles.join(", ")})` : ""
          }`,
      )
      .join("\n");
  }
}

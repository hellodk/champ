/**
 * ReviewerAgent: LLM-based code review.
 *
 * Reads diffs from the CodeAgent and checks them for correctness, style,
 * safety, and edge cases. Returns an approved/rejected verdict with
 * feedback. When the orchestrator is configured with
 * `retryFrom: { reviewer: 'code' }`, a rejection triggers a retry of
 * the CodeAgent with the reviewer's feedback.
 */
import type { LLMProvider, LLMMessage } from "../../providers/types";
import type {
  Agent,
  AgentInput,
  AgentOutput,
  SharedMemory,
  Diff,
  ReviewIssue,
} from "./types";
import { streamToString, extractJson } from "./llm-agent-base";

const REVIEWER_SYSTEM_PROMPT = `You are the Reviewer Agent. You review proposed code diffs for:
- Correctness: does the change implement the intended behavior?
- Style: does it follow project conventions?
- Safety: any security issues, data leaks, or dangerous operations?
- Edge cases: are boundary conditions handled?

Output ONLY a JSON object in this exact format:
{
  "approved": true,
  "feedback": "Looks good — handles null case and matches existing patterns.",
  "issues": []
}

When rejecting, use:
{
  "approved": false,
  "feedback": "Missing null check on line 5 of main.ts.",
  "issues": [
    {
      "severity": "error",
      "description": "Null pointer possible when user is undefined",
      "file": "src/main.ts",
      "line": 5
    }
  ]
}

Do NOT add explanation text outside the JSON.`;

interface ReviewResult {
  approved: boolean;
  feedback: string;
  issues?: ReviewIssue[];
}

export class ReviewerAgent implements Agent {
  readonly name = "reviewer";
  readonly role = "reviews code changes for correctness, style, and safety";

  constructor(private readonly provider: LLMProvider) {}

  async execute(input: AgentInput, memory: SharedMemory): Promise<AgentOutput> {
    const codeOutput = memory.getOutput("code");
    const diffs = (codeOutput?.diffs ?? []) as Diff[];

    if (diffs.length === 0) {
      const noop: AgentOutput = {
        success: true,
        output: "No diffs to review",
        approved: true,
      };
      memory.setOutput(this.name, noop);
      return noop;
    }

    const diffsText = diffs
      .map(
        (d) =>
          `=== ${d.filePath} ===\n- OLD:\n${d.oldContent}\n+ NEW:\n${d.newContent}`,
      )
      .join("\n\n");

    const messages: LLMMessage[] = [
      { role: "system", content: REVIEWER_SYSTEM_PROMPT },
      {
        role: "user",
        content: `User request: ${input.userRequest}\n\nProposed diffs:\n${diffsText}`,
      },
    ];

    const { text, error } = await streamToString(this.provider, messages);
    if (error) {
      const failure: AgentOutput = {
        success: false,
        output: "Reviewer LLM call failed",
        error,
      };
      memory.setOutput(this.name, failure);
      return failure;
    }

    const parsed = extractJson<ReviewResult>(text);
    if (!parsed || typeof parsed.approved !== "boolean") {
      const failure: AgentOutput = {
        success: false,
        output: "Reviewer returned invalid JSON",
        error: `Could not parse review from: ${text.slice(0, 200)}`,
      };
      memory.setOutput(this.name, failure);
      return failure;
    }

    // `success` mirrors `approved` so the orchestrator retry/branching
    // logic can key off the standard success flag. The approved field is
    // preserved separately for downstream consumers.
    const result: AgentOutput = {
      success: parsed.approved,
      output: parsed.feedback ?? (parsed.approved ? "Approved" : "Rejected"),
      approved: parsed.approved,
      feedback: parsed.feedback,
      issues: parsed.issues ?? [],
    };
    memory.setOutput(this.name, result);
    return result;
  }
}

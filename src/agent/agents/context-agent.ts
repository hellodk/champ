/**
 * ContextAgent: retrieves relevant code chunks for the current task.
 *
 * Uses hybrid retrieval: semantic search via the embedding index (if
 * available) and lexical search via ripgrep. Does not call the LLM.
 *
 * For Phase 3, this is a minimal implementation that reads any files
 * named in the planner's plan. Phase 6 expands it with the full
 * embedding + tree-sitter chunking pipeline.
 */
import * as vscode from "vscode";
import type {
  Agent,
  AgentInput,
  AgentOutput,
  SharedMemory,
  ContextChunk,
  Plan,
  PlanStep,
} from "./types";
import { resolveInWorkspace } from "../../utils/workspace-path";

export interface ContextAgentConfig {
  workspaceRoot?: string;
}

export class ContextAgent implements Agent {
  readonly name = "context";
  readonly role =
    "retrieves relevant code chunks via semantic + lexical search";

  constructor(private readonly config: ContextAgentConfig = {}) {}

  async execute(input: AgentInput, memory: SharedMemory): Promise<AgentOutput> {
    const workspaceRoot = this.config.workspaceRoot ?? process.cwd();
    const plannerOutput = memory.getOutput("planner");
    const plan = plannerOutput?.plan as Plan | PlanStep[] | undefined;

    // Collect all file paths mentioned in the plan.
    const filePaths = new Set<string>();
    if (plan) {
      const steps = Array.isArray(plan) ? plan : plan.steps;
      for (const step of steps) {
        for (const file of step.targetFiles ?? []) {
          filePaths.add(file);
        }
      }
    }

    // Also include any pre-supplied context.
    const chunks: ContextChunk[] = [...input.context];

    for (const relPath of filePaths) {
      const resolved = resolveInWorkspace(workspaceRoot, relPath);
      if (!resolved) continue;

      try {
        const uri = vscode.Uri.file(resolved);
        const data = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(data);
        const lineCount = text.split("\n").length;
        chunks.push({
          filePath: relPath,
          text,
          startLine: 1,
          endLine: lineCount,
        });
      } catch {
        // File might not exist yet (e.g., new file to be created).
      }
    }

    const result: AgentOutput = {
      success: true,
      output: `Collected ${chunks.length} context chunk(s)`,
      chunks,
    };
    memory.setOutput(this.name, result);
    return result;
  }
}

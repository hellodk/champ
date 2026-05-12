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
import * as path from "path";
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
  indexingService?: {
    search(
      query: string,
      topK?: number,
    ): Promise<
      Array<{
        filePath: string;
        chunkText: string;
        startLine: number;
        endLine: number;
        chunkType?: string;
        distance?: number;
      }>
    >;
  };
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
    const taskDescription: string = (plannerOutput?.output as string) ?? "";

    // Collect all file paths mentioned in the plan.
    const filePaths = new Set<string>();
    if (plan) {
      const steps = Array.isArray(plan) ? plan : plan.steps;
      for (const step of steps) {
        for (const file of step.targetFiles ?? []) {
          filePaths.add(file.replace(/\\/g, "/"));
        }
      }
    }

    const chunks: ContextChunk[] = [...input.context];

    // 1. Semantic search via IndexingService (if available).
    const semanticPaths = new Set<string>();
    if (this.config.indexingService && taskDescription) {
      try {
        const results = await this.config.indexingService.search(
          taskDescription,
          10,
        );
        for (const r of results) {
          // Normalize to workspace-relative so dedup works against plan targetFiles.
          const relPath = path
            .relative(workspaceRoot, r.filePath)
            .replace(/\\/g, "/");
          semanticPaths.add(relPath);
          chunks.push({
            filePath: relPath,
            text: r.chunkText,
            startLine: r.startLine,
            endLine: r.endLine,
          });
        }
      } catch {
        // Embedding search unavailable — fall through to file reading.
      }
    }

    // 2. Read plan-named files not already covered by semantic search.
    for (const relPath of filePaths) {
      if (semanticPaths.has(relPath)) continue;
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
        // File might not exist yet (new file to be created).
      }
    }

    const result: AgentOutput = {
      success: true,
      output: `Collected ${chunks.length} context chunk(s) (${semanticPaths.size} via semantic search, ${filePaths.size} from plan)`,
      chunks,
    };
    memory.setOutput(this.name, result);
    return result;
  }
}

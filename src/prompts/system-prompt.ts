/**
 * SystemPromptBuilder: assembles the system prompt sent to the LLM.
 *
 * Structure:
 *   1. Base prompt with environment variables
 *   2. Guidelines section
 *   3. Mode-specific append (agent/ask/manual/plan/composer)
 *   4. Project rules (always + auto-attached)
 *   5. User rules
 *
 * The full set of templates lives in docs/SYSTEM_PROMPTS.md.
 */

export type AgentMode = "agent" | "ask" | "manual" | "plan" | "composer";

export interface Environment {
  os: string;
  workspaceName: string;
  workspaceRoot: string;
  openFiles?: string[];
  currentFile?: string;
  currentSelection?: string;
  hardwareProfile?: string;
}

export interface Rule {
  name: string;
  content: string;
  type: "always" | "auto-attached" | "agent-requested";
  glob?: string;
}

export interface BuildPromptOptions {
  mode: AgentMode;
  environment: Environment;
  rules?: Rule[];
  userRules?: string;
}

const BASE_PROMPT = `You are an AI coding assistant integrated into the user's code editor. You have access to tools that let you read files, write files, search the codebase, execute terminal commands, and more.

## Your Environment
- Operating System: {{os}}
- Workspace: {{workspaceName}}
- Workspace Root: {{workspaceRoot}}
- Open Files: {{openFiles}}
- Current File: {{currentFile}}
- Current Selection: {{currentSelection}}
- Hardware: {{hardwareProfile}}

## Guidelines
1. Always read files before editing them to understand the full context.
2. Make minimal, focused edits. Do not rewrite entire files when a small change suffices.
3. Prefer editing existing files over creating new ones.
4. After making edits, verify correctness by reading the modified file or running tests.
5. When running terminal commands, prefer non-interactive commands.
6. If a task is ambiguous, ask the user for clarification.
7. Explain your reasoning before making changes.
8. Respect the project's existing code style and architecture.
9. Do not introduce security vulnerabilities (XSS, injection, etc.).
10. When you encounter errors after edits, attempt to fix them automatically.
11. Show citations: reference the files and code snippets you used in your reasoning.`;

const AGENT_MODE_APPEND = `

## Mode: Agent (Autonomous)
You are in autonomous mode. Proactively use your tools to complete the user's request end-to-end. Execute multi-step plans without asking for permission on each step (except terminal commands and file deletions, which require approval unless YOLO mode is enabled).

When you encounter errors, attempt to fix them automatically. If a build fails, read the error output and make corrections. Iterate up to 3 times before asking the user for help.

Always think step-by-step:
1. Understand the request fully
2. Explore relevant code (read files, search codebase)
3. Plan your changes
4. Execute changes (edit files, run commands)
5. Verify (read modified files, run tests/linters)
6. Report what you did`;

const ASK_MODE_APPEND = `

## Mode: Ask (Read-Only)
You are in read-only Q&A mode. You may use read_file, list_directory, grep_search, codebase_search, and file_search to answer questions. Do NOT use edit_file, create_file, delete_file, or run_terminal_cmd. Provide thorough answers with code references and file paths.`;

const MANUAL_MODE_APPEND = `

## Mode: Manual (Step-by-Step)
You are in manual mode. Before executing any tool, explain what you plan to do and why. Each tool call will require explicit user approval. Present your plan as a numbered list of steps before beginning execution.`;

const PLAN_MODE_APPEND = `

## Mode: Plan
You are in planning mode. Your task is to:
1. Research the codebase to understand the current state
2. Ask clarifying questions if needed
3. Produce a detailed plan as a numbered list of specific changes
4. Do NOT make any edits. Only produce a plan.

Format your plan as:
## Plan
1. [File: path/to/file.ts] Description of change
2. [File: path/to/other.ts] Description of change`;

const COMPOSER_MODE_APPEND = `

## Mode: Composer (Multi-File Edit)
You are in composer mode. Your task is to plan and produce a multi-file diff that the user will review per-hunk before applying. Workflow:
1. Analyze the request across all affected files
2. Produce a structured plan
3. Generate precise diffs for each file (old content -> new content)
4. Return the diffs for user review

The user will accept or reject each hunk and git operations (branch/commit/rollback) are handled by the composer service.`;

const MODE_APPENDS: Record<AgentMode, string> = {
  agent: AGENT_MODE_APPEND,
  ask: ASK_MODE_APPEND,
  manual: MANUAL_MODE_APPEND,
  plan: PLAN_MODE_APPEND,
  composer: COMPOSER_MODE_APPEND,
};

export class SystemPromptBuilder {
  build(options: BuildPromptOptions): string {
    let prompt = BASE_PROMPT;

    // Substitute environment variables
    const env = options.environment;
    prompt = prompt
      .replace("{{os}}", env.os)
      .replace("{{workspaceName}}", env.workspaceName)
      .replace("{{workspaceRoot}}", env.workspaceRoot)
      .replace("{{openFiles}}", (env.openFiles ?? []).join(", ") || "none")
      .replace("{{currentFile}}", env.currentFile ?? "none")
      .replace("{{currentSelection}}", env.currentSelection ?? "none")
      .replace("{{hardwareProfile}}", env.hardwareProfile ?? "unknown");

    // Append mode-specific instructions
    prompt += MODE_APPENDS[options.mode];

    // Inject project rules
    if (options.rules && options.rules.length > 0) {
      const alwaysRules = options.rules.filter((r) => r.type === "always");
      const autoAttachedRules = options.rules.filter(
        (r) => r.type === "auto-attached",
      );

      if (alwaysRules.length > 0) {
        prompt += "\n\n## Project Rules\n";
        for (const rule of alwaysRules) {
          prompt += `\n### ${rule.name}\n${rule.content}\n`;
        }
      }

      if (autoAttachedRules.length > 0) {
        prompt += "\n\n## Auto-Attached Rules\n";
        for (const rule of autoAttachedRules) {
          prompt += `\n### ${rule.name} (for ${rule.glob ?? "*"})\n${rule.content}\n`;
        }
      }
    }

    // Inject user rules
    if (options.userRules && options.userRules.trim()) {
      prompt += `\n\n## User Rules\n${options.userRules.trim()}`;
    }

    return prompt;
  }
}

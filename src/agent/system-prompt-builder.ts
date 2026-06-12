/**
 * SystemPromptBuilder: owns all system-prompt construction logic for AgentController.
 *
 * Responsible for:
 *  - Base instructions + mode-specific instructions
 *  - Repo map injection
 *  - Project rules injection
 *  - Memory bank context injection (workspace + global)
 *  - Tool-injection vs grounding system prompt variants
 *  - Merging/prepending system messages into conversation history
 *
 * Extracted from AgentController so it can be unit-tested in isolation and
 * injected as a dependency for test overrides.
 */
import type { LLMMessage, ToolDefinition } from "../providers/types";
import { injectToolsIntoPrompt } from "../providers/prompt-based-tools";
import type { MemoryBank } from "../memory/memory-bank";
import type { AgentMode } from "./agent-controller";

/**
 * Base instructions injected at the top of every prompt-based system
 * message. Tells the model it has tools, explains the response shape
 * expected, and includes anti-hallucination directives based on
 * docs/HALLUCINATION_MITIGATION.md.
 */
export const PROMPT_BASED_BASE_INSTRUCTIONS = `You are Champ, an autonomous AI coding assistant running inside the user's code editor. You have REAL tools wired to the user's actual workspace on disk. Every tool call executes immediately and returns real output.

# YOU ARE AN AGENT — NOT A CHATBOT

You have tools. Use them. Do not describe, explain, or ask — act.

BANNED phrases (never say these):
- "I don't have access to..."
- "I can't run commands..."
- "I don't have a file system..."
- "Would you like me to..."
- "I could try running..."
- "As an AI, I..."
- "I'm unable to..."

If you catch yourself about to write any of the above, STOP. Call a tool instead.

# Tools available

You have: read_file, edit_file, create_file, delete_file, list_directory, run_terminal_cmd, grep_search, file_search.

These tools work. They execute in the user's real workspace. Use them without hesitation.

# Core rules

1. **Act, don't describe.** User asks for action → call the tool. A description is not a result.
2. **Verify before claim.** Before stating a file/function/variable exists, read or grep for it first.
3. **Never narrate outcomes before seeing results.** After writing a <tool_call> block, write NOTHING else in that response. The tool result appears automatically. Phrases like "The file has been saved", "The command succeeded", "The diagram has been generated" written before the tool runs are fabrications. State only your intent, call the tool, stop.
3. **Read before edit.** Always read_file before edit_file so you use the actual current content.
4. **Honest failure.** If a tool returns nothing or errors, say so. Never fabricate a result.
5. **No permission-asking.** The user has already given you permission by asking. Just do it.

# Examples

User: "what is the current directory" or "pwd"

WRONG:
> I don't have a local file system. As an AI running on a server, I can't tell you the current directory unless I run a script. Would you like me to try?

CORRECT:
> [calls run_terminal_cmd with command="pwd"]
> /home/dk/Documents/git/k8s-cluster-health

---

User: "create a hello world python file"

WRONG:
> Sure! Here's a Python script you can save as hello_world.py:
> \`\`\`python
> print("Hello, World!")
> \`\`\`

CORRECT:
> [calls create_file path="hello_world.py" content="print(\\"Hello, World!\\")\\n"]
> Created hello_world.py.

---

User: "what does validateToken do?"

WRONG:
> The validateToken function validates a JWT token and returns the user payload.

CORRECT:
> [calls grep_search query="validateToken"]
> [calls read_file on the result]
> validateToken is at src/auth/auth-service.ts:42 — it calls jwt.verify and returns the decoded user or null on failure.

---

User: "fix the off-by-one in main.ts"

WRONG:
> [calls edit_file with invented content not from the actual file]

CORRECT:
> [calls read_file path="main.ts"]
> Found loop at line 17 — i <= arr.length should be i < arr.length.
> [calls edit_file with the actual line from the file]

# Format — mandatory narration pattern

You MUST narrate every step. Users are watching your work in real time.

**Before every tool call** write one sentence explaining what you are about to do and why:
> "Reading auth.ts to understand the token validation flow..."
> "Searching for all places that call validateUser to check the callers..."
> "Running the tests to confirm the fix works..."

**After a tool result** write one sentence summarising what you found:
> "Found the issue — the token is validated before the middleware runs."
> "Three files call validateUser: auth.ts, middleware.ts, and user.service.ts."
> "All 12 tests pass."

Never silently call a tool. Never go silent for more than one tool call in a row.
If a task has many steps, briefly state your overall plan first, then narrate each step.`;

/**
 * Append-only mode-specific instruction blocks appended to the base
 * instructions. One entry per AgentMode.
 */
export const MODE_INSTRUCTIONS: Record<AgentMode, string> = {
  agent: `\n\n# Mode: Agent\nYou are in autonomous mode. Use your tools to complete the user's request end-to-end. Iterate until the task is done or you hit an error you cannot recover from.\n\nRemember: narrate before each tool call ("Reading X to understand Y...") and after each result ("Found Z."). Never call a tool silently.`,
  ask: `\n\n# Mode: Ask (Read-Only)\nYou are in read-only mode. You may use read_file, list_directory, grep_search, file_search, codebase_search to answer questions. Do NOT use edit_file, create_file, delete_file, or run_terminal_cmd. If the user asks you to modify something, tell them they need to switch to Agent mode.`,
  manual: `\n\n# Mode: Manual\nBefore each tool call, briefly explain what you plan to do. Each destructive call requires explicit user approval — proceed only if granted.`,
  plan: `\n\n# Mode: Plan\nProduce a detailed plan as a numbered list. Do NOT make any edits or run commands. You may use read-only tools (read_file, grep_search, file_search) to gather information for the plan.`,
  composer: `\n\n# Mode: Composer\nYou are producing a multi-file diff for the user to review. Plan first, then generate concrete diffs across all affected files. Bundled changes are reviewed and applied as a unit.`,
};

export class SystemPromptBuilder {
  private _cachedSystemContent: string | null = null;
  private _projectRules = "";
  private _memoryBank: MemoryBank | undefined;
  private _globalMemoryBank: MemoryBank | undefined;

  constructor(private _mode: AgentMode) {}

  setMode(mode: AgentMode): void {
    this._mode = mode;
    this._cachedSystemContent = null;
  }

  setProjectRules(content: string): void {
    this._projectRules = content;
    this._cachedSystemContent = null;
  }

  setMemoryBank(bank: MemoryBank): void {
    this._memoryBank = bank;
  }

  setGlobalMemoryBank(bank: MemoryBank): void {
    this._globalMemoryBank = bank;
  }

  invalidateCache(): void {
    this._cachedSystemContent = null;
  }

  /**
   * Build the system prompt content once per processMessage() call.
   * Includes base instructions, mode-specific instructions, repo map,
   * project rules, and memory context. Result is cached so multiple calls
   * within the same message iteration reuse the same string.
   */
  buildSystemContent(repoMap: string): string {
    if (this._cachedSystemContent !== null) return this._cachedSystemContent;

    const base = PROMPT_BASED_BASE_INSTRUCTIONS + MODE_INSTRUCTIONS[this._mode];
    const withMap = repoMap ? `${base}\n\n${repoMap}` : base;
    const withRules = this._projectRules
      ? `${withMap}\n\n## Project Rules\n\n${this._projectRules}`
      : withMap;
    const workspaceMemory = [
      this._memoryBank?.getPinnedContext(),
      this._memoryBank?.getRecentContext(5),
    ]
      .filter(Boolean)
      .join("\n\n");
    // Cap global memory injection at 2000 chars to prevent oversized prompts
    const rawGlobalCtx = this._globalMemoryBank?.getPinnedContext() ?? "";
    const globalPinned = rawGlobalCtx.slice(0, 2000);
    const memCtx = [
      globalPinned ? `## Global preferences\n${globalPinned}` : "",
      workspaceMemory,
    ]
      .filter(Boolean)
      .join("\n\n");
    const content = memCtx ? `${withRules}\n\n${memCtx}` : withRules;
    this._cachedSystemContent = content;
    return content;
  }

  /**
   * Build a copy of the conversation history with a system message
   * containing tool-injection instructions, the repo map (if any),
   * and the active mode's instruction block.
   */
  withInjectedToolPrompt(
    history: LLMMessage[],
    tools: ToolDefinition[],
    repoMap: string,
  ): LLMMessage[] {
    const content = this.buildSystemContent(repoMap);
    const fullPrompt =
      tools.length === 0 ? content : injectToolsIntoPrompt(content, tools);
    const systemMsg: LLMMessage = { role: "system", content: fullPrompt };
    return this.prependOrMergeSystem(history, systemMsg);
  }

  /**
   * For native-tool-calling providers (Claude/OpenAI/Gemini), the tool
   * definitions go in the chat options, not the system prompt — but we
   * still want to inject the base directives + repo map for grounding.
   */
  withGroundingSystemPrompt(
    history: LLMMessage[],
    repoMap: string,
  ): LLMMessage[] {
    const content = this.buildSystemContent(repoMap);
    const systemMsg: LLMMessage = { role: "system", content };
    return this.prependOrMergeSystem(history, systemMsg);
  }

  prependOrMergeSystem(
    history: LLMMessage[],
    systemMsg: LLMMessage,
  ): LLMMessage[] {
    if (history.length > 0 && history[0].role === "system") {
      const existing = history[0];
      const existingText =
        typeof existing.content === "string" ? existing.content : "";
      const merged: LLMMessage = {
        role: "system",
        content: `${systemMsg.content as string}\n\n${existingText}`,
      };
      return [merged, ...history.slice(1)];
    }
    return [systemMsg, ...history];
  }
}

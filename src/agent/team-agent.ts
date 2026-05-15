/**
 * TeamAgent: executes a single agent from a TeamDefinition.
 *
 * Anti-hallucination measures baked in:
 *   1. System prompt always begins with explicit role header
 *   2. Agent can emit BLOCKED: <reason> to signal inability — never guesses
 *   3. Output extracted from <output>...</output> tags when present;
 *      <reasoning> blocks are discarded so only clean output reaches memory
 *   4. selfCritique: adversarial follow-up asks "find a problem";
 *      one retry triggered if a serious issue is found
 *   5. JSON outputFormat: stores parsed JSON in memory for downstream
 *      template interpolation
 */
import type { LLMProvider, LLMMessage } from "../providers/types";
import { streamToString, extractJson } from "./agents/llm-agent-base";
import type {
  Agent,
  AgentInput,
  AgentOutput,
  SharedMemory,
} from "./agents/types";
import type { TeamAgentDefinition } from "./team-definition";
import { TemplateInterpolator } from "./template-interpolator";
import { ToolCallingLoop } from "./tool-calling-loop";
import type { ToolRegistry } from "../tools/registry";
import { ContextWindowManager } from "../providers/context-manager";

const BLOCKED_PREFIX = "BLOCKED:";

const CRITIC_PROMPT = `Review your previous response critically.
Find at least one serious problem, gap, or incorrect assumption.
If the output is genuinely complete and correct, respond with exactly: NO_ISSUES
If there is a serious problem, respond with: ISSUE: <one sentence description>
Be honest. "looks good" is not acceptable.`;

function buildSystemPromptHeader(def: Required<TeamAgentDefinition>): string {
  return `You are ${def.name}: ${def.role}

IMPORTANT RULES:
1. Stay strictly within your assigned role. Do NOT do work that belongs to other team members. If you see another agent's assignment in the plan, skip it — that agent will handle it.

2. If you cannot complete your assigned task safely (missing context, unclear requirements, unsafe operation), respond with EXACTLY:
   BLOCKED: <one sentence explaining what is missing or unclear>

   Examples of correct BLOCKED responses:
   BLOCKED: The database schema was not provided — I cannot write queries without knowing the table structure.
   BLOCKED: The target file path is ambiguous — clarify which directory to write to.
   BLOCKED: The previous step produced an error — I cannot proceed until it is resolved.

   Do NOT guess. Do NOT hallucinate missing information. BLOCKED is always correct when uncertain.

3. When producing code or file content:
   - Wrap your reasoning in <reasoning>...</reasoning> (this is discarded)
   - Put actual output in <output>...</output> (this is used downstream)

---

`;
}

export class TeamAgent implements Agent {
  readonly name: string;
  readonly role: string;

  constructor(
    private readonly def: Required<TeamAgentDefinition>,
    private readonly provider: LLMProvider,
    private readonly streamCallback?: (chunk: string) => void,
    private readonly toolRegistry?: ToolRegistry,
  ) {
    this.name = def.id;
    this.role = def.role;
  }

  async execute(input: AgentInput, memory: SharedMemory): Promise<AgentOutput> {
    // Build memory snapshot for template interpolation
    const memSnapshot: Record<string, unknown> = {};
    for (const key of memory.keys()) {
      memSnapshot[key] = memory.get(key);
    }

    // Resolve {{key.path}} in system prompt
    const interp = new TemplateInterpolator();
    const resolvedPrompt =
      buildSystemPromptHeader(this.def) +
      interp.interpolate(this.def.systemPrompt, memSnapshot);

    if (interp.warnings.length > 0) {
      console.warn(
        `TeamAgent "${this.def.id}" has unresolved template variables:`,
        interp.warnings,
      );
      // Store warnings in memory so TeamRunner can surface them to the panel
      memory.set(`${this.def.id}_template_warnings`, interp.warnings);
    }

    // Build context from upstream chunks
    const contextText =
      input.context.length > 0
        ? "\n\n# Workspace context\n\n" +
          input.context
            .map(
              (c) => `// ${c.filePath}:${c.startLine}-${c.endLine}\n${c.text}`,
            )
            .join("\n\n---\n\n")
        : "";

    const retryContext = memory.get(`${this.def.id}_retry_context`) as
      | string
      | undefined;
    const userContent = retryContext
      ? `${input.userRequest}${contextText}\n\n[Additional context for retry]: ${retryContext}`
      : input.userRequest + contextText;

    const messages: LLMMessage[] = [
      { role: "system", content: resolvedPrompt },
      { role: "user", content: userContent },
    ];

    // Trim contextText if messages exceed the model's context window.
    // ContextWindowManager.fitMessages() only drops middle messages, which
    // doesn't apply to a 2-message array. Instead we estimate and character-trim.
    const cm = new ContextWindowManager(this.provider);
    const budget = cm.availableTokens(messages);
    if (cm.estimateTokens(messages) > budget) {
      const systemTokens = this.provider.countTokens(resolvedPrompt);
      const requestTokens = this.provider.countTokens(input.userRequest);
      const availableForContext = Math.max(
        0,
        budget - systemTokens - requestTokens - 20,
      );
      // Approximate: 1 token ≈ 4 chars
      const maxContextChars = availableForContext * 4;
      if (userContent.length > maxContextChars) {
        console.warn(
          `TeamAgent "${this.def.id}": context trimmed from ${userContent.length} to ${maxContextChars} chars to fit model window`,
        );
        messages[1] = {
          role: "user",
          content: userContent.slice(0, maxContextChars),
        };
      }
    }

    let text: string;
    let usage: { inputTokens: number; outputTokens: number };
    let error: string | undefined;

    if (this.toolRegistry && this.def.tools.length > 0) {
      // Use tool-calling loop when agent has tools
      const workspaceRoot =
        (memory.get("__workspaceRoot") as string | undefined) ?? process.cwd();
      const loop = new ToolCallingLoop(this.provider, this.toolRegistry, {
        workspaceRoot,
        abortSignal: new AbortController().signal,
        reportProgress: () => {},
        requestApproval: async () => true,
      });
      const result = await loop.run(messages, this.streamCallback);
      text = result.text;
      usage = result.usage;
      error = result.error;
    } else {
      // LLM-only path (no tools)
      const result = await streamToString(
        this.provider,
        messages,
        this.streamCallback,
        this.def.outputFormat === "json" ? { jsonFormat: true } : undefined,
      );
      text = result.text;
      usage = result.usage;
      error = result.error;
    }

    // Store token count in memory for TeamRunner to collect
    memory.set(`${this.def.id}_token_usage`, usage);

    if (error) {
      const output: AgentOutput = {
        success: false,
        output: `Agent "${this.def.id}" error: ${error}`,
        error,
      };
      memory.setOutput(this.def.outputKey, output);
      return output;
    }

    // BLOCKED detection
    const trimmed = text.trim();
    if (trimmed.startsWith(BLOCKED_PREFIX)) {
      const reason = trimmed.slice(BLOCKED_PREFIX.length).trim();
      const output: AgentOutput = {
        success: false,
        output: text,
        error: `BLOCKED: ${reason}`,
      };
      memory.setOutput(this.def.outputKey, output);
      memory.set(`${this.def.outputKey}_blocked`, true);
      memory.set(`${this.def.outputKey}_blocked_reason`, reason);
      return output;
    }

    // Extract from <output> tags if present
    const extracted = extractOutputBlock(text);

    // JSON validation + memory storage for downstream template interpolation
    if (this.def.outputFormat === "json") {
      const parsed = extractJson(extracted);
      if (parsed !== null) {
        // Store parsed object so {{outputKey.field}} works in other agents
        memory.set(this.def.outputKey, parsed);
        // Also store the raw text under a _text suffix for string interpolation
        memory.set(`${this.def.outputKey}_text`, extracted);
      } else {
        // JSON parse failed — store raw text so downstream agents aren't broken
        console.warn(
          `TeamAgent "${this.def.id}": outputFormat is "json" but output is not valid JSON — storing raw text`,
        );
        memory.set(this.def.outputKey, extracted);
      }
    }

    // Self-critique pass (opt-in per agent, doubles token cost)
    let finalOutput = extracted;
    if (this.def.selfCritique) {
      finalOutput = await this.runSelfCritique(
        messages,
        extracted,
        resolvedPrompt,
        input.userRequest + contextText,
      );
    }

    const agentOutput: AgentOutput = {
      success: true,
      output: finalOutput,
    };

    memory.setOutput(this.def.outputKey, agentOutput);
    // For text/files format: always store the output string
    if (this.def.outputFormat !== "json") {
      memory.set(this.def.outputKey, finalOutput);
    }

    return agentOutput;
  }

  private async runSelfCritique(
    originalMessages: LLMMessage[],
    originalOutput: string,
    systemPrompt: string,
    userContent: string,
  ): Promise<string> {
    const criticMessages: LLMMessage[] = [
      ...originalMessages,
      { role: "assistant", content: originalOutput },
      { role: "user", content: CRITIC_PROMPT },
    ];

    const { text: critique } = await streamToString(
      this.provider,
      criticMessages,
    );

    if (critique.includes("ISSUE:")) {
      const issueMatch = critique.match(/ISSUE:\s*(.+)/);
      const issue = issueMatch?.[1]?.trim() ?? critique;
      console.info(
        `TeamAgent "${this.def.id}" self-critique found issue: "${issue}". Retrying once.`,
      );

      const retryMessages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `${userContent}\n\n# Correction required\nYour previous attempt had this problem: ${issue}\nPlease fix it in your response.`,
        },
      ];
      const { text: retried } = await streamToString(
        this.provider,
        retryMessages,
      );
      return extractOutputBlock(retried);
    }

    return originalOutput;
  }
}

/** Extract content from <output>...</output> tags. Returns full text if no tags found. */
function extractOutputBlock(text: string): string {
  const match = text.match(/<output>([\s\S]*?)<\/output>/i);
  return match ? match[1].trim() : text;
}

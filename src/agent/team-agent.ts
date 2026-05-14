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

const BLOCKED_PREFIX = "BLOCKED:";

const CRITIC_PROMPT = `Review your previous response critically.
Find at least one serious problem, gap, or incorrect assumption.
If the output is genuinely complete and correct, respond with exactly: NO_ISSUES
If there is a serious problem, respond with: ISSUE: <one sentence description>
Be honest. "looks good" is not acceptable.`;

function buildSystemPromptHeader(def: Required<TeamAgentDefinition>): string {
  return `You are ${def.name}: ${def.role}

IMPORTANT RULES:
1. If you cannot complete your assigned task safely (missing context, unclear requirements, unsafe operation), respond with:
   BLOCKED: <one sentence explaining exactly what is missing or unclear>
   Do NOT guess, hallucinate, or produce incomplete work. BLOCKED is always the right response when uncertain.

2. When producing code or file content, wrap reasoning in <reasoning>...</reasoning> tags and your actual output in <output>...</output> tags. Only the <output> block will be used downstream.

3. Stay strictly within your assigned role. Do not do work assigned to other team members.

---

`;
}

export class TeamAgent implements Agent {
  readonly name: string;
  readonly role: string;

  constructor(
    private readonly def: Required<TeamAgentDefinition>,
    private readonly provider: LLMProvider,
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

    const messages: LLMMessage[] = [
      { role: "system", content: resolvedPrompt },
      { role: "user", content: input.userRequest + contextText },
    ];

    const { text, error } = await streamToString(this.provider, messages);

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

    // JSON validation + storage for downstream template interpolation
    if (this.def.outputFormat === "json") {
      const parsed = extractJson(extracted);
      if (parsed !== null) {
        // Store parsed object so {{outputKey.field}} works in other agents
        memory.set(this.def.outputKey, parsed);
      } else {
        console.warn(
          `TeamAgent "${this.def.id}": outputFormat is "json" but output is not valid JSON`,
        );
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
    // Also set raw string for simple {{outputKey}} interpolation in other agents
    if (!memory.has(this.def.outputKey)) {
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

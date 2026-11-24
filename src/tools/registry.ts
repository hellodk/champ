/**
 * ToolRegistry: central dispatcher for LLM tool calls.
 *
 * Tools are registered at extension activation. When the LLM invokes a
 * tool, the registry checks whether it requires approval, optionally
 * prompts the user, and then executes it.
 */
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import type { ToolDefinition } from "../providers/types";
import { PolicyEngine, type PolicyEvaluation } from "../policy/engine";
import { evaluateProfileGate } from "../policy/profiles";

const PATH_ARG_KEYS = [
  "filePath",
  "file_path",
  "path",
  "targetPath",
  "directory",
  "workspacePath",
];

const SUBAGENT_TOOLS = new Set([
  "delegate_task",
  "delegate",
  "spawn_subagent",
  "subagent",
]);

/**
 * Split a shell command on unconditional/conditional separators outside
 * quotes so every subcommand is checked against shell policy. A single
 * "curl *" DENY must not be bypassed by `echo ok && curl evil`.
 */
function splitShellCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** MCP adapters name tools `mcp_{server}_{tool}`; check each server prefix. */
function mcpServerCandidates(name: string): string[] {
  if (!name.startsWith("mcp_")) return [];
  const parts = name.slice(4).split("_").filter(Boolean);
  const candidates: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    candidates.push(parts.slice(0, i).join("_"));
  }
  return candidates;
}

function subagentCandidates(
  name: string,
  args: Record<string, unknown>,
): string[] {
  const ids: string[] = [];
  for (const key of ["agent", "subagent", "targetAgent", "model"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) ids.push(value);
  }
  if (SUBAGENT_TOOLS.has(name)) ids.push(name);
  return [...new Set(ids)];
}

/**
 * Evaluate tool, shell and path rules with one shared engine. A DENY in any
 * subject wins; otherwise a single ASK is surfaced to the caller.
 */
function evaluatePolicy(
  name: string,
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): PolicyEvaluation | null {
  const engine: PolicyEngine | undefined =
    context.policy ??
    (context.sessionPolicy
      ? new PolicyEngine({ session: context.sessionPolicy })
      : undefined);
  if (!engine) return null;
  const options = { headless: context.headless === true };
  const evaluations: PolicyEvaluation[] = [
    engine.evaluate(
      {
        kind: "tool",
        id: name,
        requiresApproval: tool.requiresApproval,
        args,
      },
      options,
    ),
  ];

  if (typeof args.command === "string") {
    evaluations.push(
      engine.evaluate({ kind: "shell", id: args.command, args }, options),
    );
    for (const segment of splitShellCommand(args.command)) {
      evaluations.push(
        engine.evaluate({ kind: "shell", id: segment, args }, options),
      );
    }
  }
  for (const server of mcpServerCandidates(name)) {
    evaluations.push(
      engine.evaluate({ kind: "mcp", id: server, args }, options),
    );
  }
  for (const subagent of subagentCandidates(name, args)) {
    evaluations.push(
      engine.evaluate({ kind: "subagent", id: subagent, args }, options),
    );
  }
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      evaluations.push(
        engine.evaluate({ kind: "path", id: value, args }, options),
      );
    }
  }
  const paths = args.paths;
  if (Array.isArray(paths)) {
    for (const value of paths) {
      if (typeof value === "string") {
        evaluations.push(
          engine.evaluate({ kind: "path", id: value, args }, options),
        );
      }
    }
  }

  const denied = evaluations.find((e) => e.decision === "DENY");
  if (denied) return denied;
  return (
    evaluations.find((e) => e.decision === "ASK") ?? evaluations[0] ?? null
  );
}

/**
 * Validate tool arguments against the declared JSON schema before execution
 * (issue #106). Returns null when valid, or a human-readable reason that is
 * fed back to the model so it can correct its call.
 */
export function validateToolArgs(tool: Tool, args: unknown): string | null {
  const params = tool.parameters;
  if (!params || typeof params !== "object") {
    return null;
  }
  if (params.type !== "object") {
    return null; // only object schemas are used by tools today
  }
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "expected a JSON object of named arguments";
  }
  const record = args as Record<string, unknown>;
  for (const req of params.required ?? []) {
    if (!(req in record)) {
      return `missing required argument "${req}"`;
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const expected = params.properties?.[key]?.type;
    if (!expected) {
      continue; // unknown extra properties are tolerated
    }
    if (!jsonTypeMatches(expected, value)) {
      return `argument "${key}" must be of type ${expected}`;
    }
  }
  return null;
}

function jsonTypeMatches(expected: string, value: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    default:
      return true; // unknown schema types are not enforced
  }
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Returns tool definitions in the format expected by LLMProvider.chat().
   */
  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  /**
   * Execute a tool by name. Handles approval flow and error reporting.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        output: `Unknown tool: ${name}`,
      };
    }

    // Schema-validate BEFORE approval so the model gets fast, actionable
    // feedback instead of a runtime failure inside the tool (issue #106).
    const validationError = validateToolArgs(tool, args);
    if (validationError) {
      return {
        success: false,
        output: `Invalid arguments for tool "${name}": ${validationError}. Fix the arguments and call the tool again.`,
      };
    }

    // Permission profiles are an operator-set floor. This gate runs before
    // policy rules and approval prompts so neither a model instruction, a
    // project policy file nor `--yes` can grant a state-changing tool in a
    // read-only session.
    const profileGate = evaluateProfileGate(context.permissionProfile, tool, {
      headless: context.headless === true,
    });
    if (profileGate.denied) {
      return {
        success: false,
        output: `Action denied by permission profile: ${profileGate.reason}`,
      };
    }

    const policyDecision = evaluatePolicy(name, tool, args, context);
    if (policyDecision?.decision === "DENY") {
      return {
        success: false,
        output: `Action denied by policy (${policyDecision.source}): ${policyDecision.reason}`,
      };
    }

    if (
      context.headless &&
      tool.requiresApproval &&
      policyDecision?.decision !== "ALLOW"
    ) {
      return {
        success: false,
        output: "Action requires approval but the session is headless.",
      };
    }
    const needsApproval = policyDecision
      ? policyDecision.decision === "ASK"
      : context.permissionProfile === "autonomous"
        ? false
        : profileGate.decision === "ASK" || tool.requiresApproval;
    if (needsApproval) {
      const preview = tool.getPreview?.(args);
      const approved = await context.requestApproval(
        `Tool "${name}" wants to execute with args: ${JSON.stringify(args, null, 2)}`,
        preview,
      );
      if (!approved) {
        return {
          success: false,
          output: `User denied execution of tool "${name}".`,
        };
      }
    }

    // Snapshot the files a mutating tool is about to change. This runs after
    // approval (no point checkpointing a denied action) but strictly before
    // the tool touches disk. Failure fails closed — no mutation is attempted
    // without a recovery point.
    if (context.onBeforeMutation && tool.mutationPaths) {
      const paths = tool
        .mutationPaths(args)
        .filter((p) => typeof p === "string" && p.length > 0);
      if (paths.length > 0) {
        try {
          await context.onBeforeMutation(paths);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            output: `Refusing to run "${name}": checkpoint failed: ${message}`,
          };
        }
      }
    }

    try {
      return await tool.execute(args, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Tool "${name}" threw an error: ${message}`,
      };
    }
  }
}

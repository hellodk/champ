/**
 * Security regression tests: policy is applied before tool execution.
 */
import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "@/tools/registry";
import { PolicyEngine, type PolicyRule } from "@/policy/engine";
import type { Tool, ToolExecutionContext } from "@/tools/types";

function tool(name: string, executed: string[]): Tool {
  return {
    name,
    description: name,
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, filePath: { type: "string" } },
    },
    requiresApproval: true,
    execute: async () => {
      executed.push(name);
      return { success: true, output: "ok" };
    },
  };
}

function context(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    workspaceRoot: process.cwd(),
    abortSignal: new AbortController().signal,
    reportProgress: vi.fn(),
    requestApproval: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("ToolRegistry policy enforcement", () => {
  it("denies a tool before calling the tool or the approval dialog", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("edit_file", executed));
    const approval = vi.fn().mockResolvedValue(true);
    const policy = new PolicyEngine({
      managed: [
        {
          scope: "managed",
          kind: "tool",
          target: "edit_file",
          decision: "DENY",
        },
      ],
    });
    const result = await registry.execute(
      "edit_file",
      {},
      context({ policy, requestApproval: approval }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/policy/i);
    expect(executed).toEqual([]);
    expect(approval).not.toHaveBeenCalled();
  });

  it("denies a shell command blocked by policy even when the tool is allowed", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("run_terminal_cmd", executed));
    const policy = new PolicyEngine({
      project: [
        {
          scope: "project",
          kind: "shell",
          target: "curl *",
          decision: "DENY",
        },
      ],
    });
    const result = await registry.execute(
      "run_terminal_cmd",
      { command: "curl https://example.com" },
      context({ policy }),
    );
    expect(result.success).toBe(false);
    expect(executed).toEqual([]);
  });

  it("denies a blocked subcommand inside a compound shell command", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("run_terminal_cmd", executed));
    const policy = new PolicyEngine({
      project: [
        {
          scope: "project",
          kind: "shell",
          target: "rm -rf *",
          decision: "DENY",
        },
      ],
    });
    const result = await registry.execute(
      "run_terminal_cmd",
      { command: "echo safe && rm -rf /tmp/data" },
      context({ policy }),
    );
    expect(result.success).toBe(false);
    expect(executed).toEqual([]);
  });

  it("denies an MCP tool when its server is blocked by policy", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("mcp_evil_server_fetch", executed));
    const policy = new PolicyEngine({
      managed: [
        {
          scope: "managed",
          kind: "mcp",
          target: "evil_server",
          decision: "DENY",
        },
      ],
    });
    const result = await registry.execute(
      "mcp_evil_server_fetch",
      {},
      context({ policy }),
    );
    expect(result.success).toBe(false);
    expect(executed).toEqual([]);
  });

  it("denies delegation to a subagent blocked by policy", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("delegate_task", executed));
    const policy = new PolicyEngine({
      project: [
        {
          scope: "project",
          kind: "subagent",
          target: "rogue",
          decision: "DENY",
        },
      ],
    });
    const result = await registry.execute(
      "delegate_task",
      { task: "do something", scope: "file", model: "rogue" },
      context({ policy }),
    );
    expect(result.success).toBe(false);
    expect(executed).toEqual([]);
  });

  it("denies paths blocked by policy", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("edit_file", executed));
    const policy = new PolicyEngine({
      managed: [
        {
          scope: "managed",
          kind: "path",
          target: "/etc/*",
          decision: "DENY",
        },
      ],
    });
    const result = await registry.execute(
      "edit_file",
      { filePath: "/etc/passwd" },
      context({ policy }),
    );
    expect(result.success).toBe(false);
    expect(executed).toEqual([]);
  });

  it("denies approval-required actions in headless mode without prompting", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("edit_file", executed));
    const approval = vi.fn().mockResolvedValue(true);
    const result = await registry.execute(
      "edit_file",
      {},
      context({ headless: true, requestApproval: approval }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/headless/i);
    expect(executed).toEqual([]);
    expect(approval).not.toHaveBeenCalled();
  });

  it("allows an explicitly permitted action without prompting", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("edit_file", executed));
    const approval = vi.fn().mockResolvedValue(true);
    const rules: PolicyRule[] = [
      {
        scope: "user",
        kind: "tool",
        target: "edit_file",
        decision: "ALLOW",
      },
    ];
    const result = await registry.execute(
      "edit_file",
      {},
      context({
        policy: new PolicyEngine({ user: rules }),
        requestApproval: approval,
      }),
    );
    expect(result.success).toBe(true);
    expect(executed).toEqual(["edit_file"]);
    expect(approval).not.toHaveBeenCalled();
  });
});

describe("ToolRegistry permission profile enforcement", () => {
  it("blocks a mutating tool under read-only before policy or approval", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("edit_file", executed));
    const approval = vi.fn().mockResolvedValue(true);
    const policy = new PolicyEngine({
      user: [
        {
          scope: "user",
          kind: "tool",
          target: "edit_file",
          decision: "ALLOW",
        },
      ],
    });
    const result = await registry.execute(
      "edit_file",
      {},
      context({
        permissionProfile: "read-only",
        policy,
        requestApproval: approval,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/permission profile/i);
    expect(executed).toEqual([]);
    expect(approval).not.toHaveBeenCalled();
  });

  it("denies supervised profile in headless mode without prompting", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("edit_file", executed));
    const approval = vi.fn().mockResolvedValue(true);
    const result = await registry.execute(
      "edit_file",
      {},
      context({
        permissionProfile: "supervised",
        headless: true,
        requestApproval: approval,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/permission profile/i);
    expect(executed).toEqual([]);
    expect(approval).not.toHaveBeenCalled();
  });

  it("autonomous profile suppresses the approval prompt", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("edit_file", executed));
    const approval = vi.fn().mockResolvedValue(false);
    const result = await registry.execute(
      "edit_file",
      {},
      context({ permissionProfile: "autonomous", requestApproval: approval }),
    );
    expect(approval).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(executed).toEqual(["edit_file"]);
  });

  it("autonomous profile still honours an explicit policy ASK", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("edit_file", executed));
    const approval = vi.fn().mockResolvedValue(false);
    const policy = new PolicyEngine({
      managed: [
        {
          scope: "managed",
          kind: "tool",
          target: "edit_file",
          decision: "ASK",
        },
      ],
    });
    const result = await registry.execute(
      "edit_file",
      {},
      context({
        permissionProfile: "autonomous",
        policy,
        requestApproval: approval,
      }),
    );
    expect(approval).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(executed).toEqual([]);
  });

  it("never lets an injected tool argument change the profile", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry();
    registry.register(tool("edit_file", executed));
    const result = await registry.execute(
      "edit_file",
      { permissionProfile: "autonomous" },
      context({ permissionProfile: "read-only" }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/permission profile/i);
    expect(executed).toEqual([]);
  });
});

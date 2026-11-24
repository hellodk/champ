/**
 * Headless tool layer.
 *
 * Exposes the fs-backed implementations in `./fs-tools` plus every other
 * built-in tool that does not require VS Code APIs, so the CLI and TUI expose
 * the same tool surface as the extension. A registry factory lets CLI/bench/
 * test code wire the agent without importing `src/extension.ts`.
 *
 * Must not import `vscode` at runtime.
 */
import { MCPClientManager, type MCPServerConfig } from "../../mcp/mcp-client";
import { McpRegistry } from "../../mcp/mcp-registry";
import { ToolRegistry } from "../registry";
import type { CredentialStore } from "../../config/credential-store";
import {
  createCodebaseSearchTool,
  type IndexingServiceGetter,
} from "../codebase-search";
import {
  createDelegateTaskTool,
  type SubAgentController,
} from "../delegate-task";
import { fetchUrlTool } from "../fetch-url";
import { generateDiagramTool } from "../generate-diagram";
import { generateDocTool } from "../generate-doc";
import { gitTool } from "../git-tool";
import { runTerminalTool } from "../run-terminal";
import { runTestsTool } from "../run-tests";
import { createWebSearchTool } from "../web-search";
import { headlessFsTools } from "./fs-tools";

export * from "./fs-tools";

export interface HeadlessToolRegistryOptions {
  /** Explicit Brave Search key. Falls back to env, then the OS keyring. */
  braveApiKey?: string;
  /** Credential store used to resolve the Brave key from the OS keyring. */
  credentials?: Pick<CredentialStore, "get">;
  /** CLI-flavoured guidance shown when the Brave key is missing. */
  missingBraveKeyHint?: string;
  /** Semantic index; when absent/null, codebase_search uses its rg fallback. */
  getIndexingService?: IndexingServiceGetter;
  /**
   * Live agent controller for `delegate_task`. Resolved per call so the
   * registry can be built before the controller exists.
   */
  getAgentController?: () => SubAgentController | null;
}

const DEFAULT_BRAVE_HINT =
  "Set BRAVE_API_KEY in the environment or store it in the OS keyring as " +
  "'brave-search-api-key' (champ config secrets).";

/**
 * Build a `ToolRegistry` pre-populated with all headless-capable built-ins.
 *
 * Approval-taking tools still go through `ToolRegistry.execute`, so the caller
 * supplies the approval policy via `ToolExecutionContext.requestApproval`
 * (auto-approve for one-shot runs with --yes, prompt for the REPL, deny
 * otherwise).
 */
export function createHeadlessToolRegistry(
  options: HeadlessToolRegistryOptions = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of headlessFsTools) {
    registry.register(tool);
  }

  registry.register(runTerminalTool);
  registry.register(runTestsTool);
  registry.register(generateDiagramTool);
  registry.register(generateDocTool);
  registry.register(fetchUrlTool);
  // The simulated BrowserTool is deliberately not registered: no headless
  // browser functionality is shipped until a real, url-guarded implementation
  // exists. Web access goes through fetchUrlTool.
  registry.register(gitTool);
  registry.register(
    createCodebaseSearchTool(options.getIndexingService ?? (() => null)),
  );

  const braveSecrets = {
    get: async (key: string): Promise<string | undefined> => {
      if (key !== "brave-search-api-key") return undefined;
      return (
        options.braveApiKey ??
        process.env.BRAVE_API_KEY ??
        process.env.BRAVE_SEARCH_API_KEY ??
        (await options.credentials?.get({ kind: "keyring", id: key }))
      );
    },
  };
  registry.register(
    createWebSearchTool(braveSecrets, {
      missingKeyHint: options.missingBraveKeyHint ?? DEFAULT_BRAVE_HINT,
    }),
  );

  const delegateMemoryStore = new Map<string, unknown>();
  registry.register(
    createDelegateTaskTool(
      {
        processMessage: (message, toolOptions) => {
          const controller = options.getAgentController?.() ?? null;
          if (!controller) {
            return Promise.resolve({
              text: "delegate_task is unavailable: no live agent controller in this run",
              toolCalls: [],
            });
          }
          return controller.processMessage(message, toolOptions);
        },
      },
      {
        set: (key, value) => delegateMemoryStore.set(key, value),
        get: (key) => delegateMemoryStore.get(key),
        subscribe: async () => undefined,
        hasChannel: () => false,
      },
    ),
  );

  return registry;
}

export interface LoadHeadlessMcpOptions {
  /** Injectable for tests and for callers managing their own lifecycle. */
  manager?: MCPClientManager;
  /** Resolver for `${{ secrets.KEY }}` tokens in MCP server env values. */
  secrets?: { get: (key: string) => PromiseLike<string | undefined> };
  onError?: (server: string, error: string) => void;
}

/** Default CLI secret resolver: environment first, then the OS keyring. */
export function createCliMcpSecretResolver(
  credentials?: Pick<CredentialStore, "get">,
): { get: (key: string) => Promise<string | undefined> } {
  return {
    get: async (key) =>
      process.env[key] ??
      (await credentials?.get({ kind: "keyring", id: key })),
  };
}

/**
 * Connect the MCP servers declared in `~/.champ/config.yaml` and register
 * their tools as `mcp_<server>_<tool>`. Failures are per-server: one broken
 * server never prevents the other tools from being used.
 */
export async function loadHeadlessMcpServers(
  registry: ToolRegistry,
  servers: MCPServerConfig[],
  options: LoadHeadlessMcpOptions = {},
): Promise<McpRegistry> {
  const manager = options.manager ?? new MCPClientManager();
  const secrets = options.secrets ?? createCliMcpSecretResolver();
  const mcpRegistry = new McpRegistry(manager, registry, secrets);
  await mcpRegistry.loadServers(servers);
  if (options.onError) {
    for (const status of mcpRegistry.getStatus()) {
      if (!status.connected && status.error) {
        options.onError(status.name, status.error);
      }
    }
  }
  return mcpRegistry;
}

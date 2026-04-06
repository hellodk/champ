/**
 * AIDev extension entry point.
 *
 * Activation philosophy: never crash. Even if the configured LLM
 * provider fails to load (missing API key, unreachable server, bad
 * config), the chat view, commands, and status bar are always
 * registered so the user has a working UI to fix the problem from.
 *
 * Provider failures are reported via:
 *   - the chat panel itself (red error bubble)
 *   - the status bar item (shows "AIDev: error" with hover details)
 *   - a one-time toast on activation
 */
import * as vscode from "vscode";
import { ProviderRegistry } from "./providers/registry";
import { ProviderFactory } from "./providers/factory";
import { ToolRegistry } from "./tools/registry";
import { readFileTool } from "./tools/read-file";
import { editFileTool } from "./tools/edit-file";
import { createFileTool } from "./tools/create-file";
import { deleteFileTool } from "./tools/delete-file";
import { listDirectoryTool } from "./tools/list-directory";
import { runTerminalTool } from "./tools/run-terminal";
import { grepSearchTool } from "./tools/grep-search";
import { fileSearchTool } from "./tools/file-search";
import { AgentController } from "./agent/agent-controller";
import { ChatViewProvider } from "./ui/chat-view-provider";
import { AidevInlineCompletionProvider } from "./completion/inline-provider";
import { MetricsCollector } from "./observability/metrics-collector";
import type { LLMProvider } from "./providers/types";

/**
 * Module-level singletons. Held so the deactivate() hook can dispose
 * them cleanly.
 */
let providerRegistry: ProviderRegistry | undefined;
let chatViewProvider: ChatViewProvider | undefined;
let metrics: MetricsCollector | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  console.log("AIDev extension activating...");

  // ---- Singletons that don't depend on the provider ------------------
  providerRegistry = new ProviderRegistry();
  metrics = new MetricsCollector();
  const factory = new ProviderFactory();

  // ---- Tool registry --------------------------------------------------
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(readFileTool);
  toolRegistry.register(editFileTool);
  toolRegistry.register(createFileTool);
  toolRegistry.register(deleteFileTool);
  toolRegistry.register(listDirectoryTool);
  toolRegistry.register(runTerminalTool);
  toolRegistry.register(grepSearchTool);
  toolRegistry.register(fileSearchTool);

  // ---- Status bar item -----------------------------------------------
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.command = "aidev.openSettings";
  statusBarItem.text = "$(loading~spin) AIDev";
  statusBarItem.tooltip = "AIDev — click to open settings";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // ---- Agent controller (created with a placeholder provider) --------
  // We use a stub provider until the real one loads. This way the chat
  // view, commands, and inline completion can register before any
  // network/SDK errors happen.
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

  const stubProvider = createStubProvider("not-configured");
  const agentController = new AgentController(
    stubProvider,
    toolRegistry,
    workspaceRoot,
  );

  agentController.onStreamDelta((delta) => {
    if (delta.type === "done" && delta.usage) {
      metrics?.recordRequest({
        requestLatency: 0,
        totalLatency: 0,
        inputTokens: delta.usage.inputTokens,
        outputTokens: delta.usage.outputTokens,
      });
    } else if (delta.type === "error" && delta.error) {
      metrics?.recordFailure(delta.error);
    }
  });

  // ---- Chat view ------------------------------------------------------
  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    agentController,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
    ),
  );

  // ---- Inline completion ----------------------------------------------
  // The inline provider holds a *reference* to the active provider, so
  // when we hot-swap below the same instance picks it up.
  const inlineProviderRef: { current: LLMProvider } = { current: stubProvider };
  const inlineProvider = new AidevInlineCompletionProvider(stubProvider);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: "**" },
      {
        async provideInlineCompletionItems(
          document,
          position,
          _context,
          token,
        ) {
          if (!isProviderReady()) return [];
          const prefix = document.getText(
            new vscode.Range(new vscode.Position(0, 0), position),
          );
          const suffix = document.getText(
            new vscode.Range(
              position,
              document.lineAt(document.lineCount - 1).range.end,
            ),
          );
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());

          const completions = await inlineProvider.provideCompletions(
            prefix,
            {
              filePath: vscode.workspace.asRelativePath(document.uri),
              language: document.languageId,
              lineNumber: position.line + 1,
              suffix,
            },
            abort.signal,
          );

          return completions.map(
            (c) =>
              new vscode.InlineCompletionItem(
                c.text,
                new vscode.Range(position, position),
              ),
          );
        },
      },
    ),
  );

  // ---- Commands -------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand("aidev.newChat", () => {
      agentController.reset();
      chatViewProvider?.postMessage({
        type: "conversationHistory",
        messages: [],
      });
    }),
    vscode.commands.registerCommand("aidev.toggleMode", async () => {
      const pick = await vscode.window.showQuickPick(
        ["agent", "ask", "manual", "plan", "composer"],
        { placeHolder: "Select agent mode" },
      );
      if (pick) {
        chatViewProvider?.postMessage({
          type: "modeChanged",
          mode: pick as never,
        });
      }
    }),
    vscode.commands.registerCommand("aidev.indexWorkspace", () => {
      void vscode.window.showInformationMessage(
        "AIDev: codebase indexing is built but not yet wired to a UI trigger in this phase.",
      );
    }),
    vscode.commands.registerCommand("aidev.restoreCheckpoint", () => {
      void vscode.window.showInformationMessage(
        "AIDev: checkpoint restore is built but not yet wired to a UI trigger in this phase.",
      );
    }),
    vscode.commands.registerCommand("aidev.openSettings", () => {
      void vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "aidev",
      );
    }),
    vscode.commands.registerCommand("aidev.setApiKey", async () => {
      const provider = await vscode.window.showQuickPick(
        ["claude", "openai", "gemini", "openai-compatible", "vllm"],
        { placeHolder: "Which provider's API key are you setting?" },
      );
      if (!provider) return;
      const key = await vscode.window.showInputBox({
        prompt: `Enter API key for ${provider}`,
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;
      const settingMap: Record<string, string> = {
        claude: "aidev.claude.apiKey",
        openai: "aidev.openai.apiKey",
        gemini: "aidev.gemini.apiKey",
        "openai-compatible": "aidev.openaiCompatible.apiKey",
        vllm: "aidev.vllm.apiKey",
      };
      await context.secrets.store(settingMap[provider], key);
      void vscode.window.showInformationMessage(
        `AIDev: ${provider} API key saved. Reloading provider...`,
      );
      await loadProvider();
    }),
  );

  // ---- Provider loader (callable on demand) ---------------------------
  /**
   * Try to (re)load the active provider. On success, hot-swaps it into
   * the agent controller, inline completion provider, and status bar.
   * On failure, leaves the stub in place and surfaces the error in the
   * chat panel + status bar.
   */
  const loadProvider = async (): Promise<void> => {
    setStatusLoading();
    try {
      const newProvider = await factory.createFromConfig(
        vscode.workspace.getConfiguration("aidev"),
        context.secrets,
      );
      // Replace any prior real provider in the registry.
      try {
        providerRegistry?.unregister(inlineProviderRef.current.name);
      } catch {
        // First load — nothing to unregister.
      }
      providerRegistry?.register(newProvider);
      agentController.setProvider(newProvider);
      inlineProvider.setProvider(newProvider);
      inlineProviderRef.current = newProvider;
      setStatusReady(newProvider);
      chatViewProvider?.postMessage({
        type: "conversationHistory",
        messages: [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatusError(message);
      chatViewProvider?.postMessage({
        type: "error",
        message: `AIDev provider not ready: ${message}\n\nOpen settings (gear icon in the status bar) to configure the active provider.`,
      });
      console.error("AIDev: provider load failed:", err);
    }
  };

  function isProviderReady(): boolean {
    return inlineProviderRef.current.name !== "not-configured";
  }

  function setStatusLoading(): void {
    if (!statusBarItem) return;
    statusBarItem.text = "$(loading~spin) AIDev";
    statusBarItem.tooltip = "AIDev — loading provider…";
  }

  function setStatusReady(provider: LLMProvider): void {
    if (!statusBarItem) return;
    statusBarItem.text = `$(robot) AIDev: ${provider.name}`;
    statusBarItem.tooltip = `AIDev provider: ${provider.name} (${provider.config.model})\nClick to open settings`;
  }

  function setStatusError(message: string): void {
    if (!statusBarItem) return;
    statusBarItem.text = "$(error) AIDev: error";
    statusBarItem.tooltip = `AIDev provider error: ${message}\nClick to open settings`;
  }

  // Initial load. Failures here are non-fatal — the chat panel will
  // show the error and the user can fix it from settings.
  await loadProvider();

  // ---- Config change watcher ------------------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("aidev")) return;
      await loadProvider();
    }),
  );

  console.log("AIDev extension activated");
}

export function deactivate(): void {
  providerRegistry?.disposeAll();
  providerRegistry = undefined;
  chatViewProvider = undefined;
  metrics = undefined;
  statusBarItem?.dispose();
  statusBarItem = undefined;
}

/**
 * Stub provider used as a placeholder when no real provider has loaded
 * yet. Every call returns an error delta directing the user to settings.
 */
function createStubProvider(name: string): LLMProvider {
  return {
    name,
    config: {
      provider: name,
      model: "none",
      maxTokens: 0,
      temperature: 0,
    },
    async *chat(): AsyncIterable<never> {
      yield {
        type: "error",
        error:
          "No LLM provider is configured. Click the AIDev status bar item or run 'AIDev: Settings' to choose a provider.",
      } as never;
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
      } as never;
    },
    async *complete(): AsyncIterable<never> {
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0 },
      } as never;
    },
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: () => 0,
    modelInfo: () => ({
      id: "none",
      name: "none",
      provider: name,
      contextWindow: 0,
      maxOutputTokens: 0,
      supportsToolUse: false,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: () => {},
  };
}

/**
 * AIDev extension entry point.
 *
 * Called by VS Code on activation. Instantiates the full dependency
 * graph (provider, tool registry, agent controller, chat view) and
 * registers all contribution points (commands, views, inline
 * completion provider, config change watcher).
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

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  console.log("AIDev extension activating...");

  // ---- Providers ------------------------------------------------------
  providerRegistry = new ProviderRegistry();
  metrics = new MetricsCollector();
  const factory = new ProviderFactory();

  let activeProvider: LLMProvider;
  try {
    activeProvider = await factory.createFromConfig(
      vscode.workspace.getConfiguration("aidev"),
      context.secrets,
    );
    providerRegistry.register(activeProvider);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(
      `AIDev: failed to initialize LLM provider — ${message}`,
    );
    // Register a placeholder so the chat view can still load with a
    // meaningful error message.
    return;
  }

  // ---- Tools ----------------------------------------------------------
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(readFileTool);
  toolRegistry.register(editFileTool);
  toolRegistry.register(createFileTool);
  toolRegistry.register(deleteFileTool);
  toolRegistry.register(listDirectoryTool);
  toolRegistry.register(runTerminalTool);
  toolRegistry.register(grepSearchTool);
  toolRegistry.register(fileSearchTool);

  // ---- Agent controller ----------------------------------------------
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const agentController = new AgentController(
    activeProvider,
    toolRegistry,
    workspaceRoot,
  );

  // Wire metrics: capture every streaming event for the status bar
  // and observability panel.
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
  const inlineProvider = new AidevInlineCompletionProvider(activeProvider);
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
    vscode.commands.registerCommand("aidev.indexWorkspace", async () => {
      void vscode.window.showInformationMessage(
        "AIDev: codebase indexing is built but not yet wired to a UI trigger in this phase.",
      );
    }),
    vscode.commands.registerCommand("aidev.restoreCheckpoint", async () => {
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
  );

  // ---- Config change watcher ------------------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration("aidev")) return;
      try {
        const newProvider = await factory.createFromConfig(
          vscode.workspace.getConfiguration("aidev"),
          context.secrets,
        );
        providerRegistry?.unregister(activeProvider.name);
        providerRegistry?.register(newProvider);
        activeProvider = newProvider;
        void vscode.window.showInformationMessage(
          `AIDev: switched to ${newProvider.name}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `AIDev: failed to reload provider — ${message}`,
        );
      }
    }),
  );

  console.log("AIDev extension activated");
}

export function deactivate(): void {
  providerRegistry?.disposeAll();
  providerRegistry = undefined;
  chatViewProvider = undefined;
  metrics = undefined;
}

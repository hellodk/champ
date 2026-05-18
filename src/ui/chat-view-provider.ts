/**
 * ChatViewProvider: bridges VS Code's sidebar WebviewView and the agent layer.
 *
 * Responsibilities:
 *   - Register as the provider for the `champ.chatView` view type.
 *   - Render the HTML/CSS/JS chat UI into the webview.
 *   - Route incoming webview messages to the AgentController.
 *   - Forward streaming deltas from the agent back to the webview.
 *   - Manage per-request AbortController so cancel works.
 */
import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import {
  type AgentController,
  PromptInjectionError,
} from "../agent/agent-controller";
import {
  createStreamDelta,
  createStreamEnd,
  createToolCallStart,
  createToolCallResult,
  createError,
  createTerminalOutputChunk,
  createPiiNotice,
  createConversationHistory,
  createSkillAutocompleteResponse,
  createProviderStatus,
  createFirstRunWelcome,
  isUserMessage,
  isSetMode,
  isNewChat,
  isCancelRequest,
  isRequestHistory,
  isApprovalResponse,
  isSkillAutocompleteRequest,
  isOpenSettingsRequest,
  isShowHelpRequest,
  isSetModelRequest,
  isFirstRunSelectRequest,
  isFirstRunDismissRequest,
  isAttachFileRequest,
  isOpenFilePickerRequest,
  isSwitchSessionRequest,
  isNewSessionRequest,
  isDeleteSessionRequest,
  isRenameSessionRequest,
  isOpenGeneratedFileRequest,
  isReloadMcpServerRequest,
  isMcpConfigSaveRequest,
  isRevertEditRequest,
  isAcceptAllEditsRequest,
  isRevertAllEditsRequest,
  isSetYoloModeRequest,
  isSetAutocompleteRequest,
  isOpenWorkflowRunRequest,
  isRerunWorkflowRequest,
  isRunMultiAgentRequest,
  isRunTeamRequest,
  isOpenConfigFileRequest,
  isRescanModelsRequest,
  isResetToAutoRequest,
  isFetchMcpMarketplaceRequest,
  isMcpMarketplaceInstallRequest,
  isAcceptHunkAtLineRequest,
  isRejectHunkAtLineRequest,
  isFocusTeamAgentRequest,
  isRunInTerminalRequest,
  isOpenMemoryBankRequest,
  isMemoryDeleteRequest,
  isMemoryPinRequest,
  isMemoryAddRequest,
  isEditUserMessage,
  createSessionList,
  createSessionTokenUsage,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
  type AvailableProviderModel,
  type ProviderStatusState,
  type FirstRunTemplate,
  type WorkflowHistoryRun,
} from "./messages";
import { EditReviewTracker } from "../agent/edit-review-tracker";
import type { StreamDelta, ContentBlock } from "../providers/types";

/**
 * Minimal interface that ChatViewProvider needs from a context resolver.
 * Mirrors the public surface of ContextResolver from src/agent/. We
 * accept this narrow shape (rather than importing ContextResolver
 * directly) so tests can supply a fake without setting up the indexing
 * service / web search tool dependencies.
 */
export interface ChatContextResolver {
  parseReferences(text: string): Array<{
    type: string;
    value: string;
    start: number;
    end: number;
  }>;
  resolve(
    refs: Array<{ type: string; value: string; start: number; end: number }>,
  ): Promise<Array<{ type: string; label: string; content: string }>>;
  /** Optional: returns the active editor context for auto-injection. */
  getEditorContext?():
    | { selection: string; filePath: string; language: string }
    | undefined;
}

/**
 * Minimal interface for a skill registry — narrowed so tests can supply
 * a fake without importing the real one.
 */
export interface ChatSkillRegistry {
  get(name: string):
    | {
        metadata: { name: string; description: string; trigger?: string };
        template: string;
      }
    | undefined;
  list(): Array<{
    metadata: { name: string; description: string };
  }>;
  matchPrefix(prefix: string): Array<{
    metadata: { name: string; description: string };
  }>;
}

/**
 * Provider of editor + workspace context used to resolve {{variables}}
 * inside skill templates. The extension layer wires this to the active
 * editor; tests can supply a fake.
 */
export interface SkillContextProvider {
  build(userInput: string): {
    workspaceRoot: string;
    date: string;
    selection?: string;
    currentFile?: string;
    language?: string;
    userInput: string;
    cursorLine?: number;
    branch?: string;
  };
}

/**
 * Variable resolver function type. Decoupled from the concrete
 * VariableResolver class so the chat view doesn't need to import it.
 */
export type SkillVariableResolver = (
  template: string,
  context: ReturnType<SkillContextProvider["build"]>,
) => string;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "champ.chatView";

  private view: vscode.WebviewView | undefined;
  private activeAbortController: AbortController | null = null;
  private streamListenerDispose: (() => void) | null = null;
  private contextResolver: ChatContextResolver | undefined;
  private skillRegistry: ChatSkillRegistry | undefined;
  private skillContextProvider: SkillContextProvider | undefined;
  private skillVariableResolver: SkillVariableResolver | undefined;
  private userMessageCallback: ((text: string) => void) | undefined;
  private webviewReadyCallback: (() => void) | undefined;
  private streamCompletedCallback:
    | ((usage?: { inputTokens: number; outputTokens: number }) => void)
    | undefined;
  private streamErrorCallback: ((error: string) => void) | undefined;
  /** Usage captured from the "done" StreamDelta; consumed once by handleUserMessage. */
  private _pendingStreamUsage?: { inputTokens: number; outputTokens: number };
  /**
   * Files attached via the paperclip button, accumulated until the
   * next user message is sent. Each entry stores the filename and
   * decoded text content. Cleared after the message is dispatched.
   */
  private pendingAttachments: Array<{
    filename: string;
    content: string;
    mimeType: string;
    isImage: boolean;
    imageData?: string;
  }> = [];
  /**
   * Pending approval requests keyed by id. Each entry is the
   * resolve callback of the promise the agent is awaiting. When the
   * webview sends back an approvalResponse, we look up the id and
   * resolve the matching promise.
   */
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private readonly editTracker = new EditReviewTracker();
  private diffOverlayController:
    | import("./diff-overlay-controller").DiffOverlayController
    | null = null;
  private memoryBank?: import("../memory/memory-bank").MemoryBank;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private agent: AgentController,
    private readonly extensionVersion: string = "",
  ) {}

  /**
   * Hot-swap the agent controller reference. Called by extension.ts
   * when the active session changes so all subsequent messages route
   * to the new session's controller.
   */
  setAgent(agent: AgentController): void {
    this.agent = agent;
    // Clear any attachments that were pending for the previous session so they
    // don't accidentally bleed into the new session's first message.
    this.pendingAttachments = [];
    this.postMessage({ type: "clearAttachments" as never } as never);
  }

  /** Called from extension.ts after DiffOverlayController is instantiated. */
  setDiffOverlayController(
    controller: import("./diff-overlay-controller").DiffOverlayController,
  ): void {
    this.diffOverlayController = controller;
  }

  /** Attach the MemoryBank so CRUD operations from the webview can be forwarded. */
  setMemoryBank(bank: import("../memory/memory-bank").MemoryBank): void {
    this.memoryBank = bank;
  }

  /**
   * Attach a context resolver. When set, every user message is scanned
   * for @-symbol references and the resolved content is appended to
   * the message before it goes to the agent.
   */
  setContextResolver(resolver: ChatContextResolver): void {
    this.contextResolver = resolver;
  }

  /**
   * Attach a skill registry. When set, user messages starting with
   * `/<name>` are looked up in the registry and the matching skill's
   * template is resolved into the actual prompt before going to the
   * agent. The user-visible "/explain ..." text is replaced with the
   * skill's prompt.
   */
  setSkillRegistry(registry: ChatSkillRegistry): void {
    this.skillRegistry = registry;
  }

  /**
   * Attach the helpers used to resolve {{variables}} inside skill
   * templates. Both must be set together — without either, skill
   * invocation falls back to passing the literal {{placeholders}}
   * through.
   */
  setSkillContext(
    provider: SkillContextProvider,
    resolver: SkillVariableResolver,
  ): void {
    this.skillContextProvider = provider;
    this.skillVariableResolver = resolver;
  }

  /**
   * Register a callback fired on every user message. Used by
   * extension.ts to auto-label the active session from the first
   * message text.
   */
  onUserMessage(callback: (text: string) => void): void {
    this.userMessageCallback = callback;
  }

  /**
   * Register a callback fired when the agent finishes a response
   * (success or error). Used by extension.ts to save session history
   * and record metrics after each turn.
   */
  onStreamCompleted(
    callback: (usage?: { inputTokens: number; outputTokens: number }) => void,
  ): void {
    this.streamCompletedCallback = callback;
  }

  onStreamError(callback: (error: string) => void): void {
    this.streamErrorCallback = callback;
  }

  /**
   * Register a callback fired when the webview sends its first
   * "requestHistory" message (the "I'm ready" signal). Used by
   * extension.ts to re-broadcast provider status, session list,
   * and other state that may have been sent before the webview resolved.
   */
  onWebviewReady(callback: () => void): void {
    this.webviewReadyCallback = callback;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToExtensionMessage) => {
        void this.handleWebviewMessage(msg);
      },
    );
  }

  /**
   * Post a message to the webview. Safe to call before resolution —
   * messages sent then are silently dropped.
   */
  postMessage(msg: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  /**
   * Broadcast a provider status update to the webview. Called by
   * extension.ts after every loadProvider() invocation so the chat
   * header indicator and the bottom-bar model dropdown stay in sync
   * with the actual active provider.
   *
   * Safe to call before the webview has resolved — postMessage is
   * a silent no-op when there's no view yet, and the webview
   * re-requests state on its next "ready" handshake.
   */
  broadcastProviderStatus(opts: {
    state: ProviderStatusState;
    providerName?: string;
    modelName?: string;
    errorMessage?: string;
    available: AvailableProviderModel[];
  }): void {
    this.postMessage(createProviderStatus(opts));
  }

  /**
   * Broadcast a first-run welcome message to the webview. Called by
   * extension.ts when it detects no config exists yet so the user
   * sees the onboarding picker.
   */
  broadcastFirstRunWelcome(templates: FirstRunTemplate[]): void {
    this.postMessage(createFirstRunWelcome(templates));
  }

  /**
   * Broadcast per-session cumulative token usage and an estimated cost
   * to the webview footer counter. Call this after every streamEnd.
   */
  broadcastSessionTokenUsage(
    sessionInputTokens: number,
    sessionOutputTokens: number,
    estimatedCostUsd = 0,
  ): void {
    this.postMessage(
      createSessionTokenUsage(
        sessionInputTokens,
        sessionOutputTokens,
        estimatedCostUsd,
      ),
    );
  }

  /**
   * Broadcast the full session list to the webview. Called by
   * extension.ts after every AgentManager change event so the
   * sidebar session list stays in sync.
   */
  broadcastSessionList(
    sessions: import("../agent-manager/types").SessionMetadata[],
    activeSessionId: string | null,
  ): void {
    this.postMessage(createSessionList(sessions, activeSessionId));
  }

  /**
   * Broadcast the workflow history to the webview. Called by
   * extension.ts after every workflow run state change so the
   * sidebar workflow strip stays in sync.
   */
  broadcastWorkflowHistory(runs: WorkflowHistoryRun[]): void {
    this.postMessage({ type: "workflowHistoryUpdate", runs });
  }

  /**
   * Handle a message from the webview. Dispatches to the appropriate
   * action based on the discriminated-union type.
   */
  private async handleWebviewMessage(
    msg: WebviewToExtensionMessage,
  ): Promise<void> {
    try {
      if (isUserMessage(msg)) {
        await this.handleUserMessage(msg.text);
      } else if (isEditUserMessage(msg)) {
        // Truncate history back to the edited turn and resubmit.
        const history = this.agent.getHistory();
        const idx = [...history]
          .reverse()
          .findIndex(
            (m) =>
              m.role === "user" &&
              (typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content)
              ).startsWith(msg.originalText),
          );
        if (idx !== -1) {
          const truncateAt = history.length - 1 - idx;
          this.agent.truncateHistory(truncateAt);
        }
        await this.handleUserMessage(msg.newText);
      } else if (isNewChat(msg)) {
        this.handleNewChat();
      } else if (isCancelRequest(msg)) {
        this.handleCancel();
      } else if (isSetMode(msg)) {
        // Push the mode through to the agent so it picks the right
        // tool restrictions and system prompt on the next turn.
        this.agent.setMode(msg.mode);
        this.postMessage({ type: "modeChanged", mode: msg.mode });
      } else if (isRequestHistory(msg)) {
        this.postMessage(createConversationHistory(this.agent.getHistory()));
        // The webview just resolved — re-broadcast all state so it
        // picks up provider status, session list, etc. that were
        // sent before the webview was ready.
        this.webviewReadyCallback?.();
      } else if (isApprovalResponse(msg)) {
        const resolve = this.pendingApprovals.get(msg.id);
        if (resolve) {
          this.pendingApprovals.delete(msg.id);
          resolve(msg.approved);
        }
      } else if (isSkillAutocompleteRequest(msg)) {
        this.handleSkillAutocompleteRequest(msg.prefix);
      } else if (isOpenSettingsRequest(msg)) {
        // The gear icon in the chat header. Opens .champ/config.yaml (creating
        // it if needed) — that's the primary config surface. Falls back to
        // VS Code settings if no workspace is open (generateConfig handles it).
        void vscode.commands.executeCommand("champ.generateConfig");
      } else if (isSetYoloModeRequest(msg)) {
        void vscode.workspace
          .getConfiguration("champ")
          .update("yoloMode", msg.enabled, vscode.ConfigurationTarget.Global);
      } else if (isSetAutocompleteRequest(msg)) {
        void vscode.workspace
          .getConfiguration("champ")
          .update(
            "autocomplete.enabled",
            msg.enabled,
            vscode.ConfigurationTarget.Global,
          );
      } else if (isShowHelpRequest(msg)) {
        // The `?` icon in the chat header. Opens docs/USER_GUIDE.md
        // as an editor tab via a dedicated extension command.
        void vscode.commands.executeCommand("champ.showHelp");
      } else if (isSetModelRequest(msg)) {
        // The model dropdown in the bottom bar. Routes to a command
        // that surgically rewrites the active YAML config's
        // top-level `provider:` line. The file watcher then triggers
        // a fresh loadProvider().
        void vscode.commands.executeCommand(
          "champ.setActiveModel",
          msg.providerName,
          ...(msg.modelName !== undefined ? [msg.modelName] : []),
        );
      } else if (isFirstRunSelectRequest(msg)) {
        // The user picked a starter config template from the
        // onboarding panel. The extension command writes the template
        // to disk and opens it in an editor.
        void vscode.commands.executeCommand(
          "champ.firstRunSelect",
          msg.templateId,
        );
      } else if (isFirstRunDismissRequest(msg)) {
        // The user dismissed the onboarding panel without picking a
        // template. The extension command sets a globalState flag so
        // it doesn't reappear.
        void vscode.commands.executeCommand("champ.firstRunDismiss");
      } else if (isAttachFileRequest(msg)) {
        // Decode the base64 content and store it until the next
        // user message is sent. The enrichment happens in
        // handleUserMessage → enrichWithAttachments.
        const isImage = /^image\/(png|jpe?g|gif|webp)$/i.test(
          msg.mimeType ?? "",
        );
        if (isImage) {
          this.pendingAttachments.push({
            filename: msg.filename,
            content: "",
            mimeType: msg.mimeType,
            isImage: true,
            imageData: msg.contentBase64,
          });
        } else {
          try {
            const content = Buffer.from(msg.contentBase64, "base64").toString(
              "utf-8",
            );
            this.pendingAttachments.push({
              filename: msg.filename,
              content,
              mimeType: msg.mimeType ?? "text/plain",
              isImage: false,
            });
          } catch {
            this.postMessage(
              createError(`Failed to decode attached file: ${msg.filename}`),
            );
          }
        }
      } else if (isOpenFilePickerRequest(msg)) {
        // VS Code webview CSP blocks native <input type="file">.
        // Use VS Code's showOpenDialog and read the files ourselves.
        void (async () => {
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "Attach",
          });
          if (!uris || uris.length === 0) return;
          for (const uri of uris) {
            try {
              const data = await vscode.workspace.fs.readFile(uri);
              const filename = uri.path.split("/").pop() ?? "file";
              const ext = filename.split(".").pop()?.toLowerCase() ?? "";
              const imageMimeMap: Record<string, string> = {
                png: "image/png",
                jpg: "image/jpeg",
                jpeg: "image/jpeg",
                gif: "image/gif",
                webp: "image/webp",
              };
              const mimeType = imageMimeMap[ext] ?? "text/plain";
              const isImage = ext in imageMimeMap;
              if (isImage) {
                const imageData = Buffer.from(data).toString("base64");
                this.pendingAttachments.push({
                  filename,
                  content: "",
                  mimeType,
                  isImage: true,
                  imageData,
                });
              } else {
                const content = new TextDecoder().decode(data);
                this.pendingAttachments.push({
                  filename,
                  content,
                  mimeType,
                  isImage: false,
                });
              }
              // Tell webview to show the chip.
              this.postMessage({
                type: "attachFileAdded" as never,
                filename,
              } as never);
            } catch {
              this.postMessage(createError(`Failed to read: ${uri.fsPath}`));
            }
          }
        })();
      } else if (isSwitchSessionRequest(msg)) {
        void vscode.commands.executeCommand(
          "champ.switchSession",
          msg.sessionId,
        );
      } else if (isNewSessionRequest(msg)) {
        void vscode.commands.executeCommand("champ.newSession", msg.label);
      } else if (isDeleteSessionRequest(msg)) {
        void vscode.commands.executeCommand(
          "champ.deleteSession",
          msg.sessionId,
        );
      } else if (isRenameSessionRequest(msg)) {
        void vscode.commands.executeCommand(
          "champ.renameSession",
          msg.sessionId,
          msg.newLabel,
        );
      } else if (isReloadMcpServerRequest(msg)) {
        void vscode.commands.executeCommand(
          "champ.reloadMcpServer",
          msg.serverName,
        );
      } else if (isMcpConfigSaveRequest(msg)) {
        void vscode.commands.executeCommand(
          "champ.saveMcpConfig",
          msg.server,
          msg.action,
        );
      } else if (isOpenWorkflowRunRequest(msg)) {
        void vscode.commands.executeCommand("champ.openWorkflowRun", msg.runId);
      } else if (isRerunWorkflowRequest(msg)) {
        void vscode.commands.executeCommand("champ.rerunWorkflow", msg.runId);
      } else if (isRunMultiAgentRequest(msg)) {
        void vscode.commands.executeCommand("champ.runMultiAgent");
      } else if (isRunTeamRequest(msg)) {
        void vscode.commands.executeCommand("champ.runTeam");
      } else if (isOpenConfigFileRequest(msg)) {
        void vscode.commands.executeCommand("champ.generateConfig");
      } else if (isRescanModelsRequest(msg)) {
        void vscode.commands.executeCommand("champ.rescanModels");
      } else if (isResetToAutoRequest(msg)) {
        void vscode.commands.executeCommand("champ.resetToAuto");
      } else if (isOpenGeneratedFileRequest(msg)) {
        const raw = msg.filePath;
        const workspaceRoot =
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
        // Resolve relative paths against the workspace root.
        const resolved = path.isAbsolute(raw)
          ? raw
          : path.join(workspaceRoot, raw);
        // Prevent path traversal — only open files inside the workspace.
        const rootWithSep = workspaceRoot.endsWith(path.sep)
          ? workspaceRoot
          : workspaceRoot + path.sep;
        if (
          workspaceRoot &&
          resolved !== workspaceRoot &&
          !resolved.startsWith(rootWithSep)
        ) {
          void vscode.window.showErrorMessage(
            `Champ: cannot open file outside workspace: ${raw}`,
          );
          return;
        }
        const fileUri = vscode.Uri.file(resolved);
        void vscode.workspace.openTextDocument(fileUri).then((doc) => {
          void vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Beside,
            preview: true,
          });
          // Open side-by-side markdown preview for .md files.
          if (resolved.endsWith(".md")) {
            void vscode.commands.executeCommand(
              "markdown.showPreviewToSide",
              fileUri,
            );
          }
        });
      } else if (isRevertEditRequest(msg)) {
        void this.revertFileEdit(msg.path, msg.restoreContent);
      } else if (isAcceptAllEditsRequest(msg)) {
        this.editTracker.reset();
      } else if (isRevertAllEditsRequest(msg)) {
        for (const edit of msg.edits) {
          await this.revertFileEdit(edit.path, edit.restoreContent);
        }
        this.editTracker.reset();
      } else if (isFetchMcpMarketplaceRequest(msg)) {
        void (async () => {
          try {
            // Read the bundled manifest from the extension package.
            // This eliminates the supply chain risk of fetching from a remote
            // URL that could be compromised — no network call, no external trust.
            const manifestUri = vscode.Uri.joinPath(
              this.extensionUri,
              "marketplace",
              "mcp-manifest.json",
            );
            const bytes = await vscode.workspace.fs.readFile(manifestUri);
            const raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
            const { McpMarketplaceClient } =
              await import("../marketplace/mcp-marketplace-client.js");
            const entries = Array.isArray(raw)
              ? (raw as unknown[]).filter((e) =>
                  McpMarketplaceClient.isValidEntry(e),
                )
              : [];
            this.postMessage({ type: "mcpMarketplaceEntries", entries });
          } catch {
            this.postMessage({ type: "mcpMarketplaceEntries", entries: [] });
          }
        })();
      } else if (isMcpMarketplaceInstallRequest(msg)) {
        void vscode.commands.executeCommand("champ.browseMcpServers");
      } else if (isAcceptHunkAtLineRequest(msg)) {
        this.diffOverlayController?.acceptHunkAtLine(msg.filePath, msg.line);
      } else if (isRejectHunkAtLineRequest(msg)) {
        this.diffOverlayController?.rejectHunkAtLine(msg.filePath, msg.line);
      } else if (isFocusTeamAgentRequest(msg)) {
        // no-op for now
      } else if (isRunInTerminalRequest(msg)) {
        void this.handleRunInTerminal(msg.command, msg.executionId);
      } else if (isOpenMemoryBankRequest(msg)) {
        void vscode.commands.executeCommand("champ.openMemoryBank");
      } else if (isMemoryDeleteRequest(msg)) {
        void this.memoryBank
          ?.delete(msg.id)
          .then(() => this.broadcastMemoryBadge());
      } else if (isMemoryPinRequest(msg)) {
        const op = msg.pinned
          ? this.memoryBank?.pin(msg.id)
          : this.memoryBank?.unpin(msg.id);
        void op?.then(() => this.broadcastMemoryBadge());
      } else if (isMemoryAddRequest(msg)) {
        void this.memoryBank
          ?.addManual(msg.text)
          .then(() => this.broadcastMemoryBadge());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage(createError(message));
    }
  }

  /** Broadcast memory count badge to the chat webview. */
  private broadcastMemoryBadge(): void {
    if (!this.memoryBank) return;
    this.postMessage({
      type: "memoryBadge",
      count: this.memoryBank.getAll().length,
    } as never);
  }

  /**
   * Run a shell command (requested from a webview bash code-block "Run" button)
   * and stream stdout chunks back to the webview as TerminalOutputChunkMessage.
   * Uses the same CommandSandbox + approval flow as run_terminal_cmd.
   */
  private async handleRunInTerminal(
    command: string,
    executionId: string,
  ): Promise<void> {
    const { spawn } = await import("child_process");
    const { CommandSandbox } = await import("../safety/command-sandbox.js");

    const sandbox = new CommandSandbox();
    const check = sandbox.check(command);
    if (!check.allowed) {
      this.postMessage(
        createTerminalOutputChunk(
          executionId,
          `Command blocked: ${check.reason}\n`,
          true,
        ),
      );
      return;
    }

    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    const proc = spawn("bash", ["-c", command], {
      cwd: workspaceRoot,
      env: { ...process.env, TERM: "dumb" },
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      this.postMessage(
        createTerminalOutputChunk(executionId, chunk.toString(), false),
      );
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      this.postMessage(
        createTerminalOutputChunk(executionId, chunk.toString(), false),
      );
    });

    proc.on("error", (err) => {
      this.postMessage(
        createTerminalOutputChunk(executionId, `Error: ${err.message}\n`, true),
      );
    });

    proc.on("close", (code) => {
      this.postMessage(
        createTerminalOutputChunk(
          executionId,
          `\nExit code: ${code ?? "unknown"}\n`,
          true,
        ),
      );
    });
  }

  /**
   * Build a requestApproval callback that posts an approvalRequest to
   * the webview and waits for the matching approvalResponse. The
   * callback shape matches AgentController's ProcessMessageOptions.
   */
  private buildApprovalCallback(): (
    description: string,
    preview?: { type: "diff" | "command"; content: string; label?: string },
  ) => Promise<boolean> {
    return (description, preview) =>
      new Promise<boolean>((resolve) => {
        const id = `approval_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 9)}`;
        this.pendingApprovals.set(id, resolve);
        this.postMessage({
          type: "approvalRequest",
          id,
          description,
          ...(preview ? { preview } : {}),
        });
      });
  }

  private async handleUserMessage(text: string): Promise<void> {
    // Cancel any previous request so a new one always wins.
    this.handleCancel();

    // Notify the extension host so it can auto-label sessions, etc.
    // Must fire before any early returns so Composer mode also triggers
    // session auto-labeling.
    this.userMessageCallback?.(text);

    // Composer mode: route to the multi-agent workflow panel instead of
    // the regular chat. The WorkflowPanel shows plan→diff→apply UX.
    if (this.agent.getMode() === "composer") {
      void vscode.commands.executeCommand("champ.runMultiAgent", text);
      return;
    }

    const controller = new AbortController();
    this.activeAbortController = controller;

    // First, expand slash commands. /<name> at the start of the message
    // is looked up in the skill registry; the matching skill's template
    // (with {{variables}} resolved) replaces the user's literal text.
    const skillExpanded = this.expandSkill(text);

    // Then resolve any @-symbol references and append the resolved
    // content to the message. The user's literal text is preserved
    // verbatim at the top so the model still sees the original phrasing.
    const contextResolved = await this.resolveContextReferences(skillExpanded);

    // Append any pending file attachments and clear the buffer.
    const enrichedContent = this.enrichWithAttachments(contextResolved);

    // Wire the agent's stream events to the webview for live rendering.
    // Dispose the prior listener first so we don't leak subscriptions.
    this.streamListenerDispose?.();
    this.streamListenerDispose = this.agent.onStreamDelta(
      (delta: StreamDelta) => {
        this.forwardStreamDelta(delta);
      },
    );

    // Attach the edit tracker so file edits are captured for diff review.
    this.agent.setEditReviewTracker(this.editTracker);

    try {
      await this.agent.processMessage(enrichedContent, {
        abortSignal: controller.signal,
        requestApproval: this.buildApprovalCallback(),
        onPiiRedacted: (summary) => {
          this.postMessage(createPiiNotice(summary));
        },
      });
      // Notify extension host exactly once — triggers save + metrics.
      // Use usage captured from the "done" delta if available.
      this.streamCompletedCallback?.(this._pendingStreamUsage);
    } catch (err) {
      if (err instanceof PromptInjectionError) {
        // Injection blocked — show clear UI message, fire stream-end so the
        // UI returns to idle state, and report via the error callback for
        // telemetry aggregation.
        this.postMessage(createStreamEnd());
        this.streamErrorCallback?.(
          `injection_blocked:${err.guardResult.category ?? "unknown"}`,
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.postMessage(createError(message));
        this.streamErrorCallback?.(message);
      }
    } finally {
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
      this.streamListenerDispose?.();
      this.streamListenerDispose = null;
      this._pendingStreamUsage = undefined;
    }
  }

  private handleNewChat(): void {
    this.handleCancel();
    this.pendingAttachments = [];
    this.postMessage({ type: "clearAttachments" as never } as never);
    this.agent.reset();
    this.postMessage(createConversationHistory([]));
  }

  private handleCancel(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    // Reject all pending tool-approval promises so they don't leak.
    for (const resolve of this.pendingApprovals.values()) {
      resolve(false);
    }
    this.pendingApprovals.clear();
  }

  /**
   * Handle a slash-command autocomplete request from the webview.
   * Queries the skill registry's matchPrefix and posts a
   * skillAutocompleteResponse with the results. Returns an empty list
   * when no registry is attached so the webview gets a clean response
   * either way.
   */
  private handleSkillAutocompleteRequest(prefix: string): void {
    if (!this.skillRegistry) {
      this.postMessage(createSkillAutocompleteResponse([], prefix));
      return;
    }
    const matches = this.skillRegistry.matchPrefix(prefix);
    const suggestions = matches.map((s) => ({
      name: s.metadata.name,
      description: s.metadata.description,
    }));
    this.postMessage(createSkillAutocompleteResponse(suggestions, prefix));
  }

  /**
   * If the user's text starts with `/<name>`, look up the skill in the
   * registry, build a SkillContext from the active editor + the rest
   * of the user input, resolve {{variables}} in the template, and
   * return the resolved prompt. Falls through to the original text
   * when:
   *   - no skill registry is attached
   *   - the message doesn't start with /
   *   - the slash command is not a known skill
   */
  private expandSkill(text: string): string {
    if (!this.skillRegistry) return text;
    const match = text.match(/^\/([A-Za-z][\w-]*)\s*(.*)$/s);
    if (!match) return text;
    const name = match[1];
    const userInput = match[2] ?? "";

    const skill = this.skillRegistry.get(name);
    if (!skill) return text;

    // Without a context provider + resolver we can't substitute
    // variables — fall back to the raw template so the model at least
    // sees the prompt rather than the literal /<name>.
    if (!this.skillContextProvider || !this.skillVariableResolver) {
      return skill.template;
    }

    const context = this.skillContextProvider.build(userInput);
    return this.skillVariableResolver(skill.template, context);
  }

  /**
   * Scan the user's message for @-symbol references and append the
   * resolved content. The original text is preserved at the top of
   * the returned string so the model still sees the user's phrasing.
   * Returns the original text unchanged if no resolver is attached or
   * no references are found.
   */
  private async resolveContextReferences(text: string): Promise<string> {
    if (!this.contextResolver) return text;

    const refs = this.contextResolver.parseReferences(text);

    const autoContextEnabled = vscode.workspace
      .getConfiguration("champ")
      .get<boolean>("autoContext.enabled", true);

    if (refs.length === 0 && autoContextEnabled) {
      const editorCtx = this.contextResolver.getEditorContext?.();
      if (editorCtx?.filePath) {
        const injectedRef: import("../agent/context-resolver").ContextReference =
          {
            type: "file",
            value: editorCtx.filePath,
            start: 0,
            end: 0,
          };
        let injectedResolved: Array<{
          type: string;
          label: string;
          content: string;
        }>;
        try {
          injectedResolved = await this.contextResolver.resolve([injectedRef]);
        } catch {
          return text;
        }
        if (injectedResolved.length > 0) {
          const baseName = path.basename(editorCtx.filePath);
          this.postMessage({ type: "autoContextNotice", files: [baseName] });
          const sections = injectedResolved
            .map((r) => `--- ${r.label} ---\n${r.content}`)
            .join("\n\n");

          // Also inject a passive git diff summary so the agent sees what
          // files are currently changed without the user having to say so.
          const gitContext = await this.getGitDiffSummary();
          const gitSection = gitContext
            ? `\n\n# Current git changes\n${gitContext}`
            : "";

          return `${text}\n\n# Referenced context\n\n${sections}${gitSection}`;
        }
      }

      // Even without an active file, inject git diff summary as passive context
      const gitContext = await this.getGitDiffSummary();
      if (gitContext) {
        return `${text}\n\n# Current git changes\n${gitContext}`;
      }
      return text;
    }

    if (refs.length === 0) return text;

    // For bare @Codebase with no explicit query, derive a search query
    // from the surrounding message text.
    //
    // Strategy: for each bare @Codebase token, use the text that appears
    // *before* the token (up to the previous reference boundary) as the
    // query. This gives each @Codebase a distinct, contextually relevant
    // query when multiple tokens appear in one message.
    //
    // Example: "explain auth @Codebase then explain caching @Codebase"
    //   → first  @Codebase gets "explain auth"
    //   → second @Codebase gets "then explain caching"
    //
    // If no before-text is found (token is first word), fall back to the
    // full stripped message. If that is also empty (bare "@Codebase" only),
    // leave value as "" so the resolver shows a clear "no query" message.
    const strippedText = text.replace(/@Codebase\b/g, "").trim();
    const enrichedRefs = refs.map((ref, idx) => {
      if (ref.type !== "codebase" || ref.value.trim()) return ref;
      // Find the end of the previous reference (or start of string).
      const prevEnd = idx === 0 ? 0 : (refs[idx - 1]?.end ?? 0);
      const before = text.slice(prevEnd, ref.start).trim();
      const query = before || strippedText;
      return query ? { ...ref, value: query } : ref;
    });

    let resolved: Array<{ type: string; label: string; content: string }>;
    try {
      resolved = await this.contextResolver.resolve(enrichedRefs);
    } catch {
      return text;
    }

    if (resolved.length === 0) return text;

    const sections = resolved
      .map((r) => `--- ${r.label} ---\n${r.content}`)
      .join("\n\n");

    return `${text}\n\n# Referenced context\n\n${sections}`;
  }

  /**
   * If there are pending file attachments, either append them to the
   * message text (text-only attachments) or return a ContentBlock[]
   * array (when any attachment is an image). Clears the buffer.
   * Returns the original text unchanged when no attachments are pending.
   */
  private enrichWithAttachments(text: string): string | ContentBlock[] {
    if (this.pendingAttachments.length === 0) return text;

    const hasImages = this.pendingAttachments.some((a) => a.isImage);
    if (!hasImages) {
      const sections = this.pendingAttachments
        .map((a) => `--- ${a.filename} ---\n${a.content}`)
        .join("\n\n");
      this.pendingAttachments = [];
      return `${text}\n\n# Attached file content (already available inline — analyze directly, do not call read_file for these)\n\n${sections}`;
    }

    const blocks: ContentBlock[] = [{ type: "text", text }];
    for (const att of this.pendingAttachments) {
      if (att.isImage && att.imageData) {
        blocks.push({
          type: "image",
          imageData: att.imageData,
          mimeType: att.mimeType,
        });
      } else {
        blocks.push({
          type: "text",
          text: `\n\n--- ${att.filename} (inline — analyze directly) ---\n${att.content}`,
        });
      }
    }
    this.pendingAttachments = [];
    return blocks;
  }

  /**
   * Translate an internal StreamDelta into one or more webview messages.
   * Text deltas become streamDelta; tool call starts/results become
   * their own events so the UI can render tool cards.
   */
  private forwardStreamDelta(delta: StreamDelta): void {
    switch (delta.type) {
      case "text":
        if (delta.text) {
          // Strip any Qwen/DeepSeek special tokens that leaked through.
          const cleaned = delta.text
            .replace(/<｜[^｜]*｜>/g, "")
            .replace(/```json\s*\{[\s\S]*?\}\s*```/g, "");
          const trimmed = cleaned.trim();
          if (trimmed) this.postMessage(createStreamDelta(trimmed));
        }
        break;
      case "tool_call_start":
        if (delta.toolCall) {
          this.postMessage(
            createToolCallStart(delta.toolCall.name, delta.toolCall.arguments),
          );
        }
        break;
      case "tool_call_end":
        if (delta.toolName) {
          this.postMessage(
            createToolCallResult(
              delta.toolName,
              delta.toolResult ?? "",
              delta.toolSuccess ?? true,
            ),
          );
        }
        if (delta.fileEditDiff) {
          this.postMessage({
            type: "fileEditDiff",
            path: delta.fileEditDiff.path,
            oldContent: delta.fileEditDiff.oldContent,
            newContent: delta.fileEditDiff.newContent,
          });
        }
        break;
      case "terminal_chunk":
        this.postMessage(
          createTerminalOutputChunk(delta.executionId, delta.chunk, delta.done),
        );
        break;
      case "done": {
        this.postMessage(createStreamEnd(delta.usage));
        // Snapshot edit records before emitEditSummary (which calls flush internally)
        const editRecords = this.editTracker.flush();
        this.emitEditSummary();
        this.editTracker.reset();
        // Stash usage for handleUserMessage to forward to the callback.
        // The callback itself is fired exactly once there, not here, to
        // avoid double-firing (processMessage emits "done" and then returns,
        // and handleUserMessage would fire a second time).
        this._pendingStreamUsage = delta.usage;
        // Register edits with DiffOverlayController for inline gutter decorations
        if (this.diffOverlayController && editRecords.length > 0) {
          for (const record of editRecords) {
            this.diffOverlayController.registerEdit({
              path: record.path,
              oldContent: record.oldContent,
              newContent: record.newContent,
            });
          }
        }
        break;
      }
      case "error":
        if (delta.error) {
          this.postMessage(createError(delta.error));
          this.streamErrorCallback?.(delta.error);
        }
        break;
      default:
        break;
    }
  }

  /** Public entry point for forwarding tool results from the registry. */
  notifyToolResult(toolName: string, result: string, success: boolean): void {
    this.postMessage(createToolCallResult(toolName, result, success));
  }

  /**
   * Return a compact git diff --stat summary of the current workspace.
   * Shows which files are changed and by how many lines — no content.
   * Returns empty string on any failure (no git, not a repo, etc.).
   */
  private async getGitDiffSummary(): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) return "";
    return new Promise<string>((resolve) => {
      execFile(
        "git",
        ["diff", "--stat", "HEAD", "--no-color"],
        { cwd: root, timeout: 2000, maxBuffer: 16 * 1024 },
        (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve("");
          } else {
            // Keep only the stat lines, strip the summary line (last line)
            const lines = stdout.trim().split("\n");
            const stat = lines.slice(0, -1).join("\n"); // drop "N files changed…"
            resolve(stat.length > 0 ? stat.slice(0, 2000) : ""); // cap at 2KB
          }
        },
      );
    });
  }

  /** Post an editSummary message for all edits accumulated this turn. */
  private emitEditSummary(): void {
    const edits = this.editTracker.flush();
    if (edits.length === 0) return;
    // Cap content size before serialising through VS Code's postMessage channel.
    // Oversized messages fail silently or crash the webview; 50 KB per side is
    // generous for display purposes while staying well within safe limits.
    const MAX_CHARS = 50_000;
    const cappedEdits = edits.map((e) => ({
      ...e,
      oldContent:
        e.oldContent.length > MAX_CHARS
          ? e.oldContent.slice(0, MAX_CHARS) + "\n…[truncated]"
          : e.oldContent,
      newContent:
        e.newContent.length > MAX_CHARS
          ? e.newContent.slice(0, MAX_CHARS) + "\n…[truncated]"
          : e.newContent,
    }));
    this.postMessage({ type: "editSummary", edits: cappedEdits });
  }

  /** Revert a file to its pre-edit content. */
  private async revertFileEdit(
    relativePath: string,
    restoreContent: string,
  ): Promise<void> {
    const workspaceRoot =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const absPath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(workspaceRoot, relativePath);
    const uri = vscode.Uri.file(absPath);
    const encoder = new TextEncoder();
    try {
      await vscode.workspace.fs.writeFile(uri, encoder.encode(restoreContent));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage(
        createError(`Revert failed for ${relativePath}: ${message}`),
      );
    }
  }

  /**
   * Render the webview HTML. Loads the chat UI bundle from the
   * webview-ui/dist directory (or an inline fallback during tests).
   */
  private renderHtml(webview: vscode.Webview): string {
    const nonce = this.generateNonce();
    // Resolve URIs for the webview bundle. In tests these may be
    // undefined because the mock Uri.joinPath returns a stub, which
    // is fine — the HTML still contains the <!DOCTYPE html> marker
    // the tests look for.
    let scriptUri = "";
    let styleUri = "";
    let codiconUri = "";
    let componentsUri = "";
    try {
      const scriptPath = vscode.Uri.joinPath(
        this.extensionUri,
        "webview-ui",
        "dist",
        "main.js",
      );
      const componentsPath = vscode.Uri.joinPath(
        this.extensionUri,
        "webview-ui",
        "dist",
        "components.js",
      );
      const stylePath = vscode.Uri.joinPath(
        this.extensionUri,
        "webview-ui",
        "dist",
        "main.css",
      );
      const codiconPath = vscode.Uri.joinPath(
        this.extensionUri,
        "webview-ui",
        "dist",
        "codicons",
        "codicon.css",
      );
      scriptUri = webview.asWebviewUri(scriptPath).toString();
      componentsUri = webview.asWebviewUri(componentsPath).toString();
      styleUri = webview.asWebviewUri(stylePath).toString();
      codiconUri = webview.asWebviewUri(codiconPath).toString();
    } catch {
      // Test environment — leave URIs empty.
    }

    const cspSource = webview.cspSource ?? "vscode-resource:";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none';
                 connect-src ${cspSource} https:;
                 style-src ${cspSource} https://cdnjs.cloudflare.com;
                 script-src 'nonce-${nonce}';
                 img-src ${cspSource} data:;
                 font-src ${cspSource};" />
  ${codiconUri ? `<link href="${codiconUri}" rel="stylesheet" />` : ""}
  <link href="${styleUri}" rel="stylesheet" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark-dimmed.min.css" />
  <title>Champ Chat</title>
  <script nonce="${nonce}">window.__CHAMP_VERSION__="${this.extensionVersion}";</script>
  <script nonce="${nonce}">
    // Load highlight.js asynchronously; main.js guards on window.hljs before calling.
    (function() {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
      s.nonce = '${nonce}';
      document.head.appendChild(s);
    })();
  </script>
</head>
<body>
  <div id="app"></div>
  <div id="champ-panels"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
  <script nonce="${nonce}" src="${componentsUri}"></script>
</body>
</html>`;
  }

  private generateNonce(): string {
    const { randomBytes } = require("crypto") as typeof import("crypto");
    return randomBytes(32).toString("base64url");
  }
}

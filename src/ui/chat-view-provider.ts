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
import type { AgentController } from "../agent/agent-controller";
import {
  createStreamDelta,
  createStreamEnd,
  createToolCallStart,
  createToolCallResult,
  createError,
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
  isSwitchSessionRequest,
  isNewSessionRequest,
  isDeleteSessionRequest,
  isRenameSessionRequest,
  createSessionList,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
  type AvailableProviderModel,
  type ProviderStatusState,
  type FirstRunTemplate,
} from "./messages";
import type { StreamDelta } from "../providers/types";

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
    refs: Array<{ type: string; value: string }>,
  ): Promise<Array<{ type: string; label: string; content: string }>>;
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
  /**
   * Files attached via the paperclip button, accumulated until the
   * next user message is sent. Each entry stores the filename and
   * decoded text content. Cleared after the message is dispatched.
   */
  private pendingAttachments: Array<{
    filename: string;
    content: string;
  }> = [];
  /**
   * Pending approval requests keyed by id. Each entry is the
   * resolve callback of the promise the agent is awaiting. When the
   * webview sends back an approvalResponse, we look up the id and
   * resolve the matching promise.
   */
  private pendingApprovals = new Map<string, (approved: boolean) => void>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private agent: AgentController,
  ) {}

  /**
   * Hot-swap the agent controller reference. Called by extension.ts
   * when the active session changes so all subsequent messages route
   * to the new session's controller.
   */
  setAgent(agent: AgentController): void {
    this.agent = agent;
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
   * Handle a message from the webview. Dispatches to the appropriate
   * action based on the discriminated-union type.
   */
  private async handleWebviewMessage(
    msg: WebviewToExtensionMessage,
  ): Promise<void> {
    try {
      if (isUserMessage(msg)) {
        await this.handleUserMessage(msg.text);
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
      } else if (isApprovalResponse(msg)) {
        const resolve = this.pendingApprovals.get(msg.id);
        if (resolve) {
          this.pendingApprovals.delete(msg.id);
          resolve(msg.approved);
        }
      } else if (isSkillAutocompleteRequest(msg)) {
        this.handleSkillAutocompleteRequest(msg.prefix);
      } else if (isOpenSettingsRequest(msg)) {
        // The gear icon in the chat header. Opens VS Code Settings
        // filtered to `champ.*` so the user lands directly on the
        // extension's settings group.
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "champ",
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
        try {
          const content = Buffer.from(msg.contentBase64, "base64").toString(
            "utf-8",
          );
          this.pendingAttachments.push({
            filename: msg.filename,
            content,
          });
        } catch {
          this.postMessage(
            createError(`Failed to decode attached file: ${msg.filename}`),
          );
        }
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
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage(createError(message));
    }
  }

  /**
   * Build a requestApproval callback that posts an approvalRequest to
   * the webview and waits for the matching approvalResponse. The
   * callback shape matches AgentController's ProcessMessageOptions.
   */
  private buildApprovalCallback(): (description: string) => Promise<boolean> {
    return (description: string) =>
      new Promise<boolean>((resolve) => {
        const id = `approval_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2, 9)}`;
        this.pendingApprovals.set(id, resolve);
        this.postMessage({
          type: "approvalRequest",
          id,
          description,
        });
      });
  }

  private async handleUserMessage(text: string): Promise<void> {
    // Cancel any previous request so a new one always wins.
    this.handleCancel();

    const controller = new AbortController();
    this.activeAbortController = controller;

    // Notify the extension host so it can auto-label sessions, etc.
    this.userMessageCallback?.(text);

    // First, expand slash commands. /<name> at the start of the message
    // is looked up in the skill registry; the matching skill's template
    // (with {{variables}} resolved) replaces the user's literal text.
    const skillExpanded = this.expandSkill(text);

    // Then resolve any @-symbol references and append the resolved
    // content to the message. The user's literal text is preserved
    // verbatim at the top so the model still sees the original phrasing.
    const contextResolved = await this.resolveContextReferences(skillExpanded);

    // Append any pending file attachments and clear the buffer.
    const enrichedText = this.enrichWithAttachments(contextResolved);

    // Wire the agent's stream events to the webview for live rendering.
    // Dispose the prior listener first so we don't leak subscriptions.
    this.streamListenerDispose?.();
    this.streamListenerDispose = this.agent.onStreamDelta(
      (delta: StreamDelta) => {
        this.forwardStreamDelta(delta);
      },
    );

    try {
      const result = await this.agent.processMessage(enrichedText, {
        abortSignal: controller.signal,
        requestApproval: this.buildApprovalCallback(),
      });
      this.postMessage(createStreamEnd());
      // Emit any trailing text that the listener may have missed
      // (e.g., if the listener was wired too late).
      if (result && "text" in result && result.text) {
        // No-op: deltas have already been forwarded.
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage(createError(message));
    } finally {
      if (this.activeAbortController === controller) {
        this.activeAbortController = null;
      }
      this.streamListenerDispose?.();
      this.streamListenerDispose = null;
    }
  }

  private handleNewChat(): void {
    this.handleCancel();
    this.agent.reset();
    this.postMessage(createConversationHistory([]));
  }

  private handleCancel(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
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
    if (refs.length === 0) return text;

    let resolved: Array<{ type: string; label: string; content: string }>;
    try {
      resolved = await this.contextResolver.resolve(refs);
    } catch {
      // If resolution fails (network error, missing file, etc.), fall
      // back to the original text rather than blocking the user.
      return text;
    }

    if (resolved.length === 0) return text;

    const sections = resolved
      .map((r) => `--- ${r.label} ---\n${r.content}`)
      .join("\n\n");

    return `${text}\n\n# Referenced context\n\n${sections}`;
  }

  /**
   * If there are pending file attachments, append them to the message
   * text as a `# Attached files` section and clear the buffer. Returns
   * the original text unchanged when no attachments are pending.
   */
  private enrichWithAttachments(text: string): string {
    if (this.pendingAttachments.length === 0) return text;

    const sections = this.pendingAttachments
      .map((a) => `--- ${a.filename} ---\n${a.content}`)
      .join("\n\n");

    this.pendingAttachments = [];

    return `${text}\n\n# Attached files\n\n${sections}`;
  }

  /**
   * Translate an internal StreamDelta into one or more webview messages.
   * Text deltas become streamDelta; tool call starts/results become
   * their own events so the UI can render tool cards.
   */
  private forwardStreamDelta(delta: StreamDelta): void {
    switch (delta.type) {
      case "text":
        if (delta.text) this.postMessage(createStreamDelta(delta.text));
        break;
      case "tool_call_start":
        if (delta.toolCall) {
          this.postMessage(
            createToolCallStart(delta.toolCall.name, delta.toolCall.arguments),
          );
        }
        break;
      case "tool_call_end":
        // Result arrives via a separate channel from the agent controller.
        break;
      case "done":
        this.postMessage(createStreamEnd(delta.usage));
        break;
      case "error":
        if (delta.error) this.postMessage(createError(delta.error));
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
    try {
      const scriptPath = vscode.Uri.joinPath(
        this.extensionUri,
        "webview-ui",
        "dist",
        "main.js",
      );
      const stylePath = vscode.Uri.joinPath(
        this.extensionUri,
        "webview-ui",
        "dist",
        "main.css",
      );
      scriptUri = webview.asWebviewUri(scriptPath).toString();
      styleUri = webview.asWebviewUri(stylePath).toString();
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
                 style-src ${cspSource} 'unsafe-inline';
                 script-src 'nonce-${nonce}';
                 img-src ${cspSource} data:;
                 font-src ${cspSource};" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Champ Chat</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private generateNonce(): string {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < 32; i++) {
      out += chars[Math.floor(Math.random() * chars.length)];
    }
    return out;
  }
}

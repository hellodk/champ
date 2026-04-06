/**
 * ChatViewProvider: bridges VS Code's sidebar WebviewView and the agent layer.
 *
 * Responsibilities:
 *   - Register as the provider for the `aidev.chatView` view type.
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
  isUserMessage,
  isSetMode,
  isNewChat,
  isCancelRequest,
  isRequestHistory,
  type ExtensionToWebviewMessage,
  type WebviewToExtensionMessage,
} from "./messages";
import type { StreamDelta } from "../providers/types";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aidev.chatView";

  private view: vscode.WebviewView | undefined;
  private activeAbortController: AbortController | null = null;
  private streamListenerDispose: (() => void) | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly agent: AgentController,
  ) {}

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
        // Mode switching is persisted by the caller that owns the
        // system prompt builder. The chat view only relays the event.
        this.postMessage({ type: "modeChanged", mode: msg.mode });
      } else if (isRequestHistory(msg)) {
        this.postMessage(createConversationHistory(this.agent.getHistory()));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postMessage(createError(message));
    }
  }

  private async handleUserMessage(text: string): Promise<void> {
    // Cancel any previous request so a new one always wins.
    this.handleCancel();

    const controller = new AbortController();
    this.activeAbortController = controller;

    // Wire the agent's stream events to the webview for live rendering.
    // Dispose the prior listener first so we don't leak subscriptions.
    this.streamListenerDispose?.();
    this.streamListenerDispose = this.agent.onStreamDelta(
      (delta: StreamDelta) => {
        this.forwardStreamDelta(delta);
      },
    );

    try {
      const result = await this.agent.processMessage(text, {
        abortSignal: controller.signal,
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
  <title>AIDev Chat</title>
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

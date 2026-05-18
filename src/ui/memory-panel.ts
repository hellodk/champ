/**
 * MemoryPanel: singleton VS Code WebviewPanel for the memory viewer.
 * Shows all stored memories, allows pin/unpin/delete, and "Remember..." add.
 */
import * as vscode from "vscode";
import type { MemoryBank } from "../memory/memory-bank";

export class MemoryPanel {
  public static currentPanel: MemoryPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly memoryBank: MemoryBank,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (message: {
        type: string;
        id?: string;
        pinned?: boolean;
        text?: string;
      }) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables,
    );
    void this.refresh();
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    memoryBank: MemoryBank,
  ): MemoryPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (MemoryPanel.currentPanel) {
      MemoryPanel.currentPanel.panel.reveal(column);
      void MemoryPanel.currentPanel.refresh();
      return MemoryPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      "champ.memoryBank",
      "Champ Memory Bank",
      column ?? vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "webview-ui", "dist"),
        ],
      },
    );

    MemoryPanel.currentPanel = new MemoryPanel(panel, extensionUri, memoryBank);
    return MemoryPanel.currentPanel;
  }

  public async refresh(): Promise<void> {
    const items = this.memoryBank.getAll();
    this.panel.webview.html = this.getHtml(items);
    await this.panel.webview.postMessage({ type: "memoryList", items });
  }

  private async handleMessage(message: {
    type: string;
    id?: string;
    pinned?: boolean;
    text?: string;
  }): Promise<void> {
    switch (message.type) {
      case "memoryDelete":
        if (message.id) {
          await this.memoryBank.delete(message.id);
          await this.refresh();
        }
        break;
      case "memoryPin":
        if (message.id) {
          if (message.pinned) {
            await this.memoryBank.pin(message.id);
          } else {
            await this.memoryBank.unpin(message.id);
          }
          await this.refresh();
        }
        break;
      case "memoryAdd":
        if (message.text?.trim()) {
          await this.memoryBank.addManual(message.text.trim());
          await this.refresh();
        }
        break;
    }
  }

  private getHtml(items: import("../memory/memory-bank").MemoryItem[]): string {
    const nonce = Array.from(
      { length: 16 },
      () => Math.random().toString(36)[2],
    ).join("");
    const componentsUri = this.panel.webview
      .asWebviewUri(
        vscode.Uri.joinPath(
          this.extensionUri,
          "webview-ui",
          "dist",
          "components.js",
        ),
      )
      .toString();

    // Suppress unused variable warning — items reserved for future SSR use.
    void items;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  </style>
  <script nonce="${nonce}">window.__CHAMP_MEMORY_PANEL__ = true;</script>
</head>
<body>
  <div id="champ-panels"></div>
  <script nonce="${nonce}" src="${componentsUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    MemoryPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}

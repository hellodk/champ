// src/ui/rules-editor-panel.ts
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { RulesEngine } from "../rules/rules-engine";
import {
  isRuleAddRequest,
  isRuleDeleteRequest,
  type RulesListMessage,
  type RulesListAckMessage,
  type RuleAddRequest,
  type RuleDeleteRequest,
} from "./messages";

// ---------------------------------------------------------------------------
// Exported helper (also used by tests)
// ---------------------------------------------------------------------------

export function buildRuleMarkdown(rule: {
  name: string;
  content: string;
  type: "always" | "auto-attached" | "agent-requested";
  glob?: string;
}): string {
  const allowedTypes = ["always", "auto-attached", "agent-requested"] as const;
  if (!allowedTypes.includes(rule.type)) {
    throw new Error(`Invalid rule type: ${rule.type}`);
  }

  // Strip newlines to prevent YAML frontmatter injection
  let name = rule.name.replace(/[\n\r]/g, " ").trim();
  const type = rule.type; // already validated against the enum above
  const glob = rule.glob ? rule.glob.replace(/[\n\r]/g, " ").trim() : undefined;

  // Quote name if it contains special YAML characters
  if (/[:#\[\]{}|>&*!,?'"]/.test(name)) {
    name = JSON.stringify(name);
  }

  let frontmatter = `---\nname: ${name}\ntype: ${type}`;
  if (rule.type === "auto-attached" && glob) {
    frontmatter += `\nglob: "${glob}"`;
  }
  frontmatter += "\n---\n";
  return frontmatter + rule.content;
}

// ---------------------------------------------------------------------------
// VS Code WebviewPanel
// ---------------------------------------------------------------------------

export class RulesEditorPanel {
  private panel: vscode.WebviewPanel;
  private _disposed = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceRoot: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "champ.rulesEditor",
      "Champ: Rules Editor",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    this.panel.webview.html = this.renderHtml();
    this.panel.onDidDispose(() => {
      this._disposed = true;
    });

    this.panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      await this.handleMessage(msg);
    });

    void this.sendRulesList();
  }

  private rulesDir(): string {
    return path.join(this.workspaceRoot, ".champ", "rules");
  }

  private async sendRulesList(): Promise<void> {
    const engine = new RulesEngine(this.workspaceRoot);
    const loaded = await engine.loadRulesFromDirectory(this.rulesDir());
    const msg: RulesListMessage = {
      type: "rulesList",
      rules: loaded.map((r) => ({
        name: r.name,
        content: r.content,
        type: r.type,
        glob: r.glob,
      })),
    };
    void this.panel.webview.postMessage(msg);
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type: string };

    if (isRuleAddRequest(m as ReturnType<typeof Object.assign>)) {
      await this.handleAdd(m as RuleAddRequest);
    } else if (isRuleDeleteRequest(m as ReturnType<typeof Object.assign>)) {
      await this.handleDelete(m as RuleDeleteRequest);
    }
  }

  private async handleAdd(req: RuleAddRequest): Promise<void> {
    const dir = this.rulesDir();
    await fs.mkdir(dir, { recursive: true });

    const safeName = req.rule.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const filePath = path.join(dir, `${safeName}.md`);

    let exists = false;
    try {
      await fs.access(filePath);
      exists = true;
    } catch {
      /* not found */
    }

    if (exists) {
      const choice = await vscode.window.showWarningMessage(
        `Rule "${safeName}" already exists. Overwrite?`,
        { modal: true },
        "Overwrite",
      );
      if (choice !== "Overwrite") return;
    }

    const content = buildRuleMarkdown(req.rule);
    await fs.writeFile(filePath, content, "utf-8");
    void vscode.window.showInformationMessage(
      `Rule saved: .champ/rules/${safeName}.md`,
    );
    await this.broadcastRulesList();
  }

  private async handleDelete(req: RuleDeleteRequest): Promise<void> {
    const dir = this.rulesDir();
    const safeName = req.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const filePath = path.join(dir, `${safeName}.md`);

    const choice = await vscode.window.showWarningMessage(
      `Delete rule "${req.name}"? This cannot be undone.`,
      { modal: true },
      "Delete",
    );
    if (choice !== "Delete") return;

    try {
      await fs.unlink(filePath);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Failed to delete rule: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    void vscode.window.showInformationMessage(`Rule "${req.name}" deleted.`);
    await this.broadcastRulesList();
  }

  private async broadcastRulesList(): Promise<void> {
    const engine = new RulesEngine(this.workspaceRoot);
    const loaded = await engine.loadRulesFromDirectory(this.rulesDir());
    const ack: RulesListAckMessage = {
      type: "rulesListAck",
      rules: loaded.map((r) => ({
        name: r.name,
        content: r.content,
        type: r.type,
        glob: r.glob,
      })),
    };
    void this.panel.webview.postMessage(ack);
  }

  dispose(): void {
    this._disposed = true;
    this.panel.dispose();
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  private renderHtml(): string {
    const { randomBytes } = require("crypto") as typeof import("crypto");
    const nonce = randomBytes(32).toString("base64url");
    const cspSource = this.panel.webview.cspSource ?? "vscode-resource:";
    const scriptUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        "webview-ui",
        "dist",
        "components.js",
      ),
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; script-src 'nonce-${nonce}' ${cspSource}; style-src 'unsafe-inline'; img-src ${cspSource} data:;">
<style>
html,body{margin:0;padding:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px}
#champ-ruleseditor{height:100%}
</style>
</head>
<body>
<div id="champ-ruleseditor"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.vscode = vscode;
  if (window.ChampPanels && window.ChampPanels.mountRulesEditor) {
    window.ChampPanels.mountRulesEditor(document.getElementById('champ-ruleseditor'));
  }
</script>
</body>
</html>`;
  }
}

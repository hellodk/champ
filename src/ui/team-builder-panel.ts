// src/ui/team-builder-panel.ts
import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as yaml from "js-yaml";
import { TeamLoader } from "../agent/team-loader";
import type { TeamDefinition } from "../agent/team-definition";
import {
  isTeamBuilderSaveRequest,
  type TeamBuilderSaveRequest,
  type TeamBuilderLoadMessage,
  type TeamBuilderSaveAckMessage,
} from "./messages";

// ---------------------------------------------------------------------------
// Exported helpers (also used by tests)
// ---------------------------------------------------------------------------

/** Layout constants matching AgentGraphPanel.tsx */
const NODE_WIDTH = 160;
const NODE_HEIGHT = 48;
const H_GAP = 40;
const V_GAP = 60;
const PADDING = 20;

/**
 * Assigns x/y positions to each agent using a layered DAG layout
 * (identical algorithm to AgentGraphPanel.computeLayout, duplicated here
 * so it can be tested without a DOM).
 */
export function parseAgentPositions(
  agents: Array<{ id: string; dependsOn: string[] }>,
): Map<string, { x: number; y: number }> {
  if (agents.length === 0) return new Map();

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const idSet = new Set(agents.map((a) => a.id));

  for (const a of agents) {
    inDegree.set(a.id, 0);
    adj.set(a.id, []);
  }
  for (const a of agents) {
    for (const dep of a.dependsOn) {
      if (idSet.has(dep)) {
        adj.get(dep)!.push(a.id);
        inDegree.set(a.id, (inDegree.get(a.id) ?? 0) + 1);
      }
    }
  }

  const layers: string[][] = [];
  let frontier = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id);

  while (frontier.length > 0) {
    layers.push(frontier);
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighborId of adj.get(id) ?? []) {
        const newDeg = (inDegree.get(neighborId) ?? 0) - 1;
        inDegree.set(neighborId, newDeg);
        if (newDeg === 0) next.push(neighborId);
      }
    }
    frontier = next;
  }

  const positions = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, layerIdx) => {
    const y = PADDING + layerIdx * (NODE_HEIGHT + V_GAP) + NODE_HEIGHT / 2;
    layer.forEach((id, colIdx) => {
      const x = PADDING + colIdx * (NODE_WIDTH + H_GAP) + NODE_WIDTH / 2;
      positions.set(id, { x, y });
    });
  });

  return positions;
}

/**
 * Serializes a team definition (from TeamBuilderSaveRequest) to YAML,
 * omitting empty optional fields so the output stays clean.
 *
 * NOTE: This function manually maps each known field of TeamAgentDefinition.
 * If new fields are added to that type, they must also be added here or they
 * will be silently dropped from the serialized output.
 * TODO: consider using js-yaml dump for agent nodes directly (with a
 * schema/filter) to make this exhaustive automatically.
 *
 * multiline / special-character values (e.g. systemPrompt) are safe because
 * the entire doc is serialized via yaml.dump(), which applies block scalar
 * style for multiline strings and quoting for values containing colons etc.
 */
export function buildTeamYaml(team: TeamBuilderSaveRequest["team"]): string {
  const doc: Record<string, unknown> = {
    name: team.name,
    description: team.description,
    version: team.version,
    agents: team.agents.map((a) => {
      const node: Record<string, unknown> = {
        id: a.id,
        name: a.name,
        role: a.role,
        systemPrompt: a.systemPrompt,
      };
      if (a.dependsOn.length > 0) node.dependsOn = a.dependsOn;
      if (a.condition) node.condition = a.condition;
      if (a.tools.length > 0) node.tools = a.tools;
      if (a.model) node.model = a.model;
      if (a.maxTokens !== 4096) node.maxTokens = a.maxTokens;
      if (a.outputKey !== a.id) node.outputKey = a.outputKey;
      if (a.outputFormat !== "text") node.outputFormat = a.outputFormat;
      if (a.selfCritique) node.selfCritique = true;
      if (a.subscribes.length > 0) node.subscribes = a.subscribes;
      return node;
    }),
  };

  // Only emit defaults/execution fields that differ from the TeamLoader defaults
  const defaults: Record<string, unknown> = {};
  if (team.defaults.model) defaults.model = team.defaults.model;
  if (team.defaults.maxTokens) defaults.maxTokens = team.defaults.maxTokens;
  if (team.defaults.temperature !== undefined)
    defaults.temperature = team.defaults.temperature;
  if (Object.keys(defaults).length > 0) doc.defaults = defaults;

  const exec: Record<string, unknown> = {};
  if (team.execution.maxParallel !== 3)
    exec.maxParallel = team.execution.maxParallel;
  if (team.execution.totalTokenBudget !== 100000)
    exec.totalTokenBudget = team.execution.totalTokenBudget;
  if (team.execution.timeoutSeconds !== 120)
    exec.timeoutSeconds = team.execution.timeoutSeconds;
  if (team.execution.retries !== 1) exec.retries = team.execution.retries;
  if (!team.execution.checkpoints) exec.checkpoints = false;
  if (team.execution.mode !== "auto") exec.mode = team.execution.mode;
  if (Object.keys(exec).length > 0) doc.execution = exec;

  return yaml.dump(doc, {
    lineWidth: 120,
    quotingType: '"',
    forceQuotes: false,
  });
}

// ---------------------------------------------------------------------------
// VS Code WebviewPanel
// ---------------------------------------------------------------------------

export class TeamBuilderPanel {
  private panel: vscode.WebviewPanel;
  private _disposed = false;

  /** Fires whenever a team is loaded so the chat view can show the Design tab. */
  readonly onTeamLoaded: vscode.Event<TeamDefinition | null>;
  private _onTeamLoaded = new vscode.EventEmitter<TeamDefinition | null>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceRoot: string,
    teamToEdit?: TeamDefinition,
  ) {
    this.onTeamLoaded = this._onTeamLoaded.event;

    this.panel = vscode.window.createWebviewPanel(
      "champ.teamBuilder",
      "Champ: Team Builder",
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

    // Send the initial load message once the webview is ready
    void this.sendLoadMessage(teamToEdit ?? null);
  }

  private async sendLoadMessage(team: TeamDefinition | null): Promise<void> {
    const loader = new TeamLoader(this.workspaceRoot);
    const all = await loader.loadAll();
    const existingNames = all.map((t) => t.name);

    const msg: TeamBuilderLoadMessage = {
      type: "teamBuilderLoad",
      team,
      existingNames,
    };
    void this.panel.webview.postMessage(msg);
    this._onTeamLoaded.fire(team);
  }

  private async handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const m = msg as { type: string };

    if (isTeamBuilderSaveRequest(m as ReturnType<typeof Object.assign>)) {
      await this.handleSave(m as TeamBuilderSaveRequest);
    }
  }

  private async handleSave(req: TeamBuilderSaveRequest): Promise<void> {
    const teamsDir = path.join(this.workspaceRoot, ".champ", "teams");
    await fs.mkdir(teamsDir, { recursive: true });

    const safeName = req.team.name.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const filePath = path.join(teamsDir, `${safeName}.yaml`);

    // Check for overwrite
    let exists = false;
    try {
      await fs.access(filePath);
      exists = true;
    } catch {
      /* file does not exist — fine */
    }

    if (exists) {
      const choice = await vscode.window.showWarningMessage(
        `"${safeName}.yaml" already exists. Overwrite?`,
        { modal: true },
        "Overwrite",
      );
      if (choice !== "Overwrite") return;
    }

    const yamlContent = buildTeamYaml(req.team);
    await fs.writeFile(filePath, yamlContent, "utf-8");

    const ack: TeamBuilderSaveAckMessage = {
      type: "teamBuilderSaveAck",
      savedPath: filePath,
    };
    void this.panel.webview.postMessage(ack);
    void vscode.window.showInformationMessage(
      `Team saved to ${path.relative(this.workspaceRoot, filePath)}`,
    );
  }

  dispose(): void {
    this._disposed = true;
    this._onTeamLoaded.dispose();
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
#champ-teambuilder{height:100%}
</style>
</head>
<body>
<div id="champ-teambuilder"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.vscode = vscode;
  if (window.ChampPanels && window.ChampPanels.mountTeamBuilder) {
    window.ChampPanels.mountTeamBuilder(document.getElementById('champ-teambuilder'));
  }
</script>
</body>
</html>`;
  }
}

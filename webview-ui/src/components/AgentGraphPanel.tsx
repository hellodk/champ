// webview-ui/src/components/AgentGraphPanel.tsx
import { signal, computed } from "@preact/signals";
import { useEffect } from "preact/hooks";
import type {
  TeamRunState,
  TeamAgentRunState,
  TeamAgentStatus,
} from "../types";
import type { TeamBuilderLoadMessage } from "../../../src/ui/messages";

export const teamStateSignal = signal<TeamRunState | null>(null);
const isVisibleSignal = computed(() => teamStateSignal.value !== null);

type AgentGraphTab = "graph" | "timeline";
const activeTabSignal = signal<AgentGraphTab>("graph");
const expandedAgentIdSignal = signal<string | null>(null);

// Design-mode state — populated when a teamBuilderLoad message arrives
const designTeamSignal = signal<{
  name: string;
  agents: Array<{ id: string; name: string; dependsOn: string[] }>;
} | null>(null);
type PanelMode = "live" | "design";
const activePanelModeSignal = signal<PanelMode>("live");

function getVsCode(): { postMessage: (msg: unknown) => void } {
  if (
    typeof (window as unknown as { vscode?: unknown }).vscode !== "undefined"
  ) {
    return (
      window as unknown as { vscode: { postMessage: (msg: unknown) => void } }
    ).vscode;
  }
  return (
    window as unknown as {
      acquireVsCodeApi: () => { postMessage: (msg: unknown) => void };
    }
  ).acquireVsCodeApi();
}

const NODE_WIDTH = 160;
const NODE_HEIGHT = 48;
const H_GAP = 40;
const V_GAP = 60;
const PADDING = 20;

function statusToFill(status: TeamAgentStatus): string {
  switch (status) {
    case "pending":
      return "var(--vscode-badge-background)";
    case "running":
      return "var(--vscode-progressBar-background)";
    case "done":
      return "var(--vscode-terminal-ansiGreen)";
    case "failed":
      return "var(--vscode-inputValidation-errorBackground)";
    case "skipped":
      return "var(--vscode-disabledForeground)";
    case "blocked":
      return "var(--vscode-inputValidation-warningBackground)";
    default:
      return "var(--vscode-badge-background)";
  }
}

function statusToStroke(status: TeamAgentStatus): string {
  switch (status) {
    case "pending":
      return "var(--vscode-badge-foreground)";
    case "running":
      return "var(--vscode-focusBorder)";
    case "done":
      return "var(--vscode-terminal-ansiGreen)";
    case "failed":
      return "var(--vscode-inputValidation-errorBorder)";
    case "skipped":
      return "var(--vscode-descriptionForeground)";
    case "blocked":
      return "var(--vscode-inputValidation-warningBorder)";
    default:
      return "var(--vscode-badge-foreground)";
  }
}

function computeLayout(
  agents: TeamAgentRunState[],
  dependsOnMap: Map<string, string[]>,
): Map<string, { x: number; y: number }> {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const idSet = new Set(agents.map((a) => a.id));

  for (const a of agents) {
    inDegree.set(a.id, 0);
    adj.set(a.id, []);
  }

  for (const a of agents) {
    for (const dep of dependsOnMap.get(a.id) ?? []) {
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

function AgentNode({
  agent,
  x,
  y,
}: {
  agent: TeamAgentRunState;
  x: number;
  y: number;
}): JSX.Element {
  const fill = statusToFill(agent.status);
  const stroke = statusToStroke(agent.status);

  function handleClick(): void {
    getVsCode().postMessage({ type: "focusTeamAgent", agentId: agent.id });
  }

  return (
    <g
      transform={`translate(${x - NODE_WIDTH / 2}, ${y - NODE_HEIGHT / 2})`}
      onClick={handleClick}
      style="cursor:pointer;"
    >
      <rect
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={6}
        ry={6}
        fill={fill}
        stroke={stroke}
        strokeWidth={2}
      />
      <text
        x={NODE_WIDTH / 2}
        y={NODE_HEIGHT * 0.42}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="var(--vscode-editor-foreground)"
        fontSize={12}
        fontWeight="600"
      >
        {agent.name.length > 18 ? agent.name.slice(0, 16) + "…" : agent.name}
      </text>
      <text
        x={NODE_WIDTH / 2}
        y={NODE_HEIGHT * 0.72}
        textAnchor="middle"
        dominantBaseline="middle"
        fill="var(--vscode-descriptionForeground)"
        fontSize={10}
      >
        {agent.status}
        {agent.status === "running" ? " ●" : ""}
      </text>
    </g>
  );
}

function EdgeLine({
  fromPos,
  toPos,
}: {
  fromPos: { x: number; y: number };
  toPos: { x: number; y: number };
}): JSX.Element {
  const x1 = fromPos.x;
  const y1 = fromPos.y + NODE_HEIGHT / 2;
  const x2 = toPos.x;
  const y2 = toPos.y - NODE_HEIGHT / 2;
  const midY = (y1 + y2) / 2;

  return (
    <path
      d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
      fill="none"
      stroke="var(--vscode-descriptionForeground)"
      strokeWidth={1.5}
      opacity={0.6}
    />
  );
}

function TimelineRow({ agent }: { agent: TeamAgentRunState }): JSX.Element {
  const durationMs =
    agent.startTime && agent.endTime ? agent.endTime - agent.startTime : null;
  const durationStr =
    durationMs !== null ? `${(durationMs / 1000).toFixed(1)}s` : "—";
  const tokenStr = agent.tokenCount
    ? agent.tokenCount.toLocaleString() + " tk"
    : "—";
  const statusColor: Record<string, string> = {
    done: "var(--vscode-terminal-ansiGreen)",
    failed: "var(--vscode-inputValidation-errorBorder)",
    running: "var(--vscode-progressBar-background)",
    skipped: "var(--vscode-disabledForeground)",
    blocked: "var(--vscode-inputValidation-warningBorder)",
    pending: "var(--vscode-descriptionForeground)",
  };
  const color = statusColor[agent.status] ?? "var(--vscode-foreground)";
  const isExpanded = expandedAgentIdSignal.value === agent.id;
  const isExpandable = ["done", "failed", "blocked"].includes(agent.status);

  return (
    <div data-agentid={agent.id}>
      <div
        onClick={
          isExpandable
            ? () => {
                expandedAgentIdSignal.value = isExpanded ? null : agent.id;
              }
            : undefined
        }
        style={`display:flex;align-items:center;padding:4px 8px;
                border-bottom:1px solid var(--vscode-panel-border);font-size:11px;gap:8px;
                cursor:${isExpandable ? "pointer" : "default"};
                background:${isExpanded ? "var(--vscode-list-hoverBackground)" : "transparent"};`}
      >
        <span
          style={`width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;`}
        />
        <span style="flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          {agent.name}
        </span>
        {isExpandable && (
          <span style="color:var(--vscode-descriptionForeground);font-size:10px;">
            {isExpanded ? "▲" : "▼"}
          </span>
        )}
        <span style="color:var(--vscode-descriptionForeground);width:48px;text-align:right;flex-shrink:0;">
          {durationStr}
        </span>
        <span style="color:var(--vscode-descriptionForeground);width:52px;text-align:right;flex-shrink:0;">
          {tokenStr}
        </span>
        <span style="color:var(--vscode-descriptionForeground);width:52px;text-align:right;flex-shrink:0;">
          {agent.costUsd !== undefined
            ? agent.costUsd < 0.001
              ? "< $0.001"
              : `$${agent.costUsd.toFixed(3)}`
            : "—"}
        </span>
      </div>
      {isExpanded && agent.output && (
        <div
          style="padding:6px 10px;font-size:11px;font-family:var(--vscode-editor-font-family,monospace);
                    white-space:pre-wrap;word-break:break-word;max-height:160px;overflow-y:auto;
                    background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);"
        >
          {agent.output.slice(0, 2000)}
          {agent.output.length > 2000 && (
            <span style="opacity:0.5;display:block;margin-top:4px;">
              …{(agent.output.length - 2000).toLocaleString()} chars truncated
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentGraphPanel(): JSX.Element | null {
  // Register both message listeners inside useEffect with cleanup — fixes
  // module-level listener leak: each panel re-creation previously added
  // another permanent listener with no removal path (#9).
  useEffect(() => {
    const handleMessage = (e: MessageEvent): void => {
      const msg = e.data as { type: string };
      if (msg.type === "teamBuilderLoad") {
        const m = msg as TeamBuilderLoadMessage;
        if (m.team) {
          designTeamSignal.value = {
            name: m.team.name,
            agents: m.team.agents.map((a) => ({
              id: a.id,
              name: a.name,
              dependsOn: a.dependsOn ?? [],
            })),
          };
          activePanelModeSignal.value = "design";
        }
      }
    };

    const handleTeamUpdate = (e: Event): void => {
      const msg = (e as CustomEvent<{ state: TeamRunState }>).detail;
      if (msg.state) {
        teamStateSignal.value = msg.state;
      }
    };

    window.addEventListener("message", handleMessage);
    window.addEventListener("champ:teamUpdate", handleTeamUpdate);
    return () => {
      window.removeEventListener("message", handleMessage);
      window.removeEventListener("champ:teamUpdate", handleTeamUpdate);
    };
  }, []);

  const hasLive = isVisibleSignal.value;
  const hasDesign = designTeamSignal.value !== null;

  if (!hasLive && !hasDesign) return null;

  // If only one mode is active, force that tab
  const panelMode: PanelMode =
    hasLive && !hasDesign
      ? "live"
      : !hasLive && hasDesign
        ? "design"
        : activePanelModeSignal.value;

  function handleClose(): void {
    if (panelMode === "live") {
      teamStateSignal.value = null;
    } else {
      designTeamSignal.value = null;
    }
  }

  // ── Design mode rendering ─────────────────────────────────────────────────
  if (panelMode === "design") {
    const dt = designTeamSignal.value!;
    const dependsOnMap = new Map<string, string[]>(
      dt.agents.map((a) => [a.id, a.dependsOn]),
    );

    // Build fake TeamAgentRunState[] for reuse of computeLayout
    const fakeAgents: TeamAgentRunState[] = dt.agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: "pending" as const,
      output: "",
      tokenCount: 0,
      validationWarnings: [],
      retryCount: 0,
    }));

    const positions = computeLayout(fakeAgents, dependsOnMap);

    let maxX = 0;
    let maxY = 0;
    for (const { x, y } of positions.values()) {
      if (x + NODE_WIDTH / 2 + PADDING > maxX)
        maxX = x + NODE_WIDTH / 2 + PADDING;
      if (y + NODE_HEIGHT / 2 + PADDING > maxY)
        maxY = y + NODE_HEIGHT / 2 + PADDING;
    }

    return (
      <div
        style="position:fixed; top:48px; right:12px; width:340px;
               background:var(--vscode-sideBar-background);
               border:1px solid var(--vscode-panel-border);
               border-radius:6px; z-index:60; box-shadow:0 4px 16px rgba(0,0,0,0.3);
               overflow:hidden;"
      >
        <div
          style="display:flex; justify-content:space-between; align-items:center;
                 padding:6px 10px; background:var(--vscode-titleBar-activeBackground);"
        >
          <div style="display:flex; gap:4px; align-items:center;">
            {hasLive && (
              <button
                onClick={() => {
                  activePanelModeSignal.value = "live";
                }}
                style={`background:none; border:none; cursor:pointer; font-size:11px; font-weight:600; padding:2px 6px; border-radius:3px; ${panelMode === "live" ? "color:var(--vscode-foreground); background:var(--vscode-panel-border);" : "color:var(--vscode-descriptionForeground);"}`}
              >
                Live
              </button>
            )}
            {hasDesign && (
              <button
                onClick={() => {
                  activePanelModeSignal.value = "design";
                }}
                style={`background:none; border:none; cursor:pointer; font-size:11px; font-weight:600; padding:2px 6px; border-radius:3px; ${panelMode === "design" ? "color:var(--vscode-foreground); background:var(--vscode-panel-border);" : "color:var(--vscode-descriptionForeground);"}`}
              >
                Design
              </button>
            )}
            <span style="font-size:12px; font-weight:600; margin-left:4px;">
              {dt.name}
            </span>
          </div>
          <button
            onClick={handleClose}
            style="background:none; border:none; cursor:pointer; color:var(--vscode-icon-foreground); font-size:14px;"
            aria-label="Close design preview"
          >
            x
          </button>
        </div>
        <div style="overflow:auto; max-height:300px;">
          <svg
            width={Math.max(maxX, 200)}
            height={Math.max(maxY, 120)}
            xmlns="http://www.w3.org/2000/svg"
          >
            {fakeAgents.map((agent) =>
              (dependsOnMap.get(agent.id) ?? []).map((depId) => {
                const fromPos = positions.get(depId);
                const toPos = positions.get(agent.id);
                if (!fromPos || !toPos) return null;
                return (
                  <EdgeLine
                    key={`${depId}->${agent.id}`}
                    fromPos={fromPos}
                    toPos={toPos}
                  />
                );
              }),
            )}
            {fakeAgents.map((agent) => {
              const pos = positions.get(agent.id);
              if (!pos) return null;
              return (
                <AgentNode key={agent.id} agent={agent} x={pos.x} y={pos.y} />
              );
            })}
          </svg>
        </div>
        <div
          style="padding:4px 10px; font-size:10px; color:var(--vscode-descriptionForeground);
                 border-top:1px solid var(--vscode-panel-border);"
        >
          {fakeAgents.length} agent{fakeAgents.length !== 1 ? "s" : ""} — design
          preview
        </div>
      </div>
    );
  }

  // ── Live mode rendering (original code) ───────────────────────────────────
  const state = teamStateSignal.value!;

  const dependsOnMap = new Map<string, string[]>();
  for (const agent of state.agents) {
    dependsOnMap.set(agent.id, []);
  }

  const positions = computeLayout(state.agents, dependsOnMap);

  let maxX = 0;
  let maxY = 0;
  for (const { x, y } of positions.values()) {
    if (x + NODE_WIDTH / 2 + PADDING > maxX)
      maxX = x + NODE_WIDTH / 2 + PADDING;
    if (y + NODE_HEIGHT / 2 + PADDING > maxY)
      maxY = y + NODE_HEIGHT / 2 + PADDING;
  }
  const svgWidth = Math.max(maxX, 200);
  const svgHeight = Math.max(maxY, 120);

  return (
    <div
      style="position:fixed; top:48px; right:12px; width:340px;
             background:var(--vscode-sideBar-background);
             border:1px solid var(--vscode-panel-border);
             border-radius:6px; z-index:60; box-shadow:0 4px 16px rgba(0,0,0,0.3);
             overflow:hidden;"
    >
      {/* Title bar */}
      <div
        style="display:flex; justify-content:space-between; align-items:center;
               padding:6px 10px; background:var(--vscode-titleBar-activeBackground);"
      >
        <div style="display:flex; gap:4px; align-items:center;">
          {hasDesign && (
            <button
              onClick={() => {
                activePanelModeSignal.value = "design";
              }}
              style="background:none; border:none; cursor:pointer; font-size:11px; font-weight:600; padding:2px 6px; border-radius:3px; color:var(--vscode-descriptionForeground);"
            >
              Design
            </button>
          )}
          <span style="font-size:12px; font-weight:600;">
            {state.teamName} — {state.status}
          </span>
        </div>
        <button
          onClick={handleClose}
          style="background:none; border:none; cursor:pointer; color:var(--vscode-icon-foreground); font-size:14px;"
          aria-label="Close agent graph"
        >
          x
        </button>
      </div>
      {/* Tab bar */}
      <div style="display:flex;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBarSectionHeader-background);">
        {(["graph", "timeline"] as AgentGraphTab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => {
              activeTabSignal.value = tab;
            }}
            style={`flex:1;padding:5px 0;border:none;cursor:pointer;font-size:11px;font-weight:600;
              text-transform:capitalize;
              background:${activeTabSignal.value === tab ? "var(--vscode-list-activeSelectionBackground)" : "transparent"};
              color:${activeTabSignal.value === tab ? "var(--vscode-list-activeSelectionForeground)" : "var(--vscode-foreground)"};
              border-bottom:${activeTabSignal.value === tab ? "2px solid var(--vscode-focusBorder)" : "2px solid transparent"};`}
          >
            {tab === "graph" ? "Graph" : "Timeline"}
          </button>
        ))}
      </div>
      {/* Graph tab */}
      {activeTabSignal.value === "graph" && (
        <div style="overflow:auto; max-height:300px;">
          <svg
            width={svgWidth}
            height={svgHeight}
            xmlns="http://www.w3.org/2000/svg"
          >
            {state.agents.map((agent) =>
              (dependsOnMap.get(agent.id) ?? []).map((depId) => {
                const fromPos = positions.get(depId);
                const toPos = positions.get(agent.id);
                if (!fromPos || !toPos) return null;
                return (
                  <EdgeLine
                    key={`${depId}->${agent.id}`}
                    fromPos={fromPos}
                    toPos={toPos}
                  />
                );
              }),
            )}
            {state.agents.map((agent) => {
              const pos = positions.get(agent.id);
              if (!pos) return null;
              return (
                <AgentNode key={agent.id} agent={agent} x={pos.x} y={pos.y} />
              );
            })}
          </svg>
        </div>
      )}
      {/* Timeline tab */}
      {activeTabSignal.value === "timeline" && (
        <div style="overflow-y:auto;max-height:300px;">
          <div style="display:flex;padding:4px 8px;font-size:10px;opacity:0.6;border-bottom:1px solid var(--vscode-panel-border);gap:8px;">
            <span style="width:8px;flex-shrink:0;" />
            <span style="flex:1;">Agent</span>
            <span style="width:48px;text-align:right;flex-shrink:0;">
              Duration
            </span>
            <span style="width:52px;text-align:right;flex-shrink:0;">
              Tokens
            </span>
            <span style="width:52px;text-align:right;flex-shrink:0;">Cost</span>
          </div>
          {state.agents.map((agent) => (
            <TimelineRow key={agent.id} agent={agent} />
          ))}
        </div>
      )}
      <div
        style="padding:4px 10px; font-size:10px; color:var(--vscode-descriptionForeground);
               border-top:1px solid var(--vscode-panel-border);"
      >
        {state.totalTokens.toLocaleString()} tokens
        {state.tokenBudget
          ? ` / ${state.tokenBudget.toLocaleString()} budget`
          : ""}
      </div>
    </div>
  );
}

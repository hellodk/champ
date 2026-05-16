// webview-ui/src/components/AgentGraphPanel.tsx
import { signal, computed } from "@preact/signals";
import type {
  TeamRunState,
  TeamAgentRunState,
  TeamAgentStatus,
} from "../types";

export const teamStateSignal = signal<TeamRunState | null>(null);
const isVisibleSignal = computed(() => teamStateSignal.value !== null);

window.addEventListener("champ:teamUpdate", (e: Event) => {
  const msg = (e as CustomEvent<{ state: TeamRunState }>).detail;
  if (msg.state) {
    teamStateSignal.value = msg.state;
  }
});

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

export function AgentGraphPanel(): JSX.Element | null {
  if (!isVisibleSignal.value) return null;

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

  function handleClose(): void {
    teamStateSignal.value = null;
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
        <span style="font-size:12px; font-weight:600;">
          {state.teamName} — {state.status}
        </span>
        <button
          onClick={handleClose}
          style="background:none; border:none; cursor:pointer; color:var(--vscode-icon-foreground); font-size:14px;"
          aria-label="Close agent graph"
        >
          x
        </button>
      </div>
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

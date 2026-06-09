// webview-ui/src/components/TeamBuilderPanel.tsx
import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type {
  TeamBuilderLoadMessage,
  TeamBuilderSaveAckMessage,
} from "../../../src/ui/messages";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentNode {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  dependsOn: string[];
  condition: string;
  tools: string[];
  model: string;
  maxTokens: number;
  outputKey: string;
  outputFormat: "text" | "json" | "files";
  selfCritique: boolean;
  subscribes: string[];
}

interface NodePos {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_W = 160;
const NODE_H = 48;
const H_GAP = 40;
const V_GAP = 60;
const PAD = 20;

const BUILT_IN_TEMPLATES: Array<{
  label: string;
  description: string;
  agents: AgentNode[];
}> = [
  {
    label: "Plan → Code → Review",
    description: "Three-agent pipeline: planner, coder, reviewer",
    agents: [
      {
        id: "planner",
        name: "Planner",
        role: "Decomposes the task into a step-by-step plan",
        systemPrompt:
          "You are a senior engineer. Produce a numbered implementation plan only. No code.",
        dependsOn: [],
        condition: "",
        tools: [],
        model: "",
        maxTokens: 4096,
        outputKey: "planner",
        outputFormat: "text",
        selfCritique: false,
        subscribes: [],
      },
      {
        id: "coder",
        name: "Coder",
        role: "Implements the plan",
        systemPrompt:
          "You are an expert programmer. Follow the plan in {{planner}} exactly. Write production-quality code.",
        dependsOn: ["planner"],
        condition: "",
        tools: ["edit_file", "create_file", "read_file"],
        model: "",
        maxTokens: 8192,
        outputKey: "coder",
        outputFormat: "files",
        selfCritique: false,
        subscribes: [],
      },
      {
        id: "reviewer",
        name: "Reviewer",
        role: "Reviews the implementation for correctness and style",
        systemPrompt:
          "You are a meticulous code reviewer. Review the files changed by {{coder}} and list any issues.",
        dependsOn: ["coder"],
        condition: "",
        tools: ["read_file", "grep_search"],
        model: "",
        maxTokens: 4096,
        outputKey: "reviewer",
        outputFormat: "text",
        selfCritique: true,
        subscribes: [],
      },
    ],
  },
  {
    label: "Research → Draft → Edit",
    description: "Writing pipeline: researcher, drafter, editor",
    agents: [
      {
        id: "researcher",
        name: "Researcher",
        role: "Gathers context and facts",
        systemPrompt:
          "You are a research assistant. Gather all relevant information for the user request.",
        dependsOn: [],
        condition: "",
        tools: ["grep_search", "codebase_search", "read_file"],
        model: "",
        maxTokens: 4096,
        outputKey: "researcher",
        outputFormat: "text",
        selfCritique: false,
        subscribes: [],
      },
      {
        id: "drafter",
        name: "Drafter",
        role: "Writes the first draft",
        systemPrompt:
          "Using the research in {{researcher}}, write a complete first draft.",
        dependsOn: ["researcher"],
        condition: "",
        tools: [],
        model: "",
        maxTokens: 8192,
        outputKey: "drafter",
        outputFormat: "text",
        selfCritique: false,
        subscribes: [],
      },
      {
        id: "editor",
        name: "Editor",
        role: "Polishes and fact-checks the draft",
        systemPrompt: "Edit {{drafter}} for clarity, concision, and accuracy.",
        dependsOn: ["drafter"],
        condition: "",
        tools: [],
        model: "",
        maxTokens: 4096,
        outputKey: "editor",
        outputFormat: "text",
        selfCritique: true,
        subscribes: [],
      },
    ],
  },
  {
    label: "Audit → Fix → Verify",
    description: "Quality pipeline: auditor, fixer, verifier",
    agents: [
      {
        id: "auditor",
        name: "Auditor",
        role: "Finds all issues in the codebase",
        systemPrompt:
          "You are a code auditor. Find every bug, security issue, and code smell. Output a JSON array of issues.",
        dependsOn: [],
        condition: "",
        tools: ["grep_search", "read_file", "codebase_search"],
        model: "",
        maxTokens: 4096,
        outputKey: "auditor",
        outputFormat: "json",
        selfCritique: false,
        subscribes: [],
      },
      {
        id: "fixer",
        name: "Fixer",
        role: "Fixes all issues found by the auditor",
        systemPrompt: "Fix every issue listed in {{auditor}}.",
        dependsOn: ["auditor"],
        condition: "",
        tools: ["edit_file", "read_file"],
        model: "",
        maxTokens: 8192,
        outputKey: "fixer",
        outputFormat: "files",
        selfCritique: false,
        subscribes: [],
      },
      {
        id: "verifier",
        name: "Verifier",
        role: "Confirms all fixes are applied correctly",
        systemPrompt:
          "Verify that every issue in {{auditor}} has been fixed by {{fixer}}.",
        dependsOn: ["fixer"],
        condition: "",
        tools: ["read_file", "grep_search"],
        model: "",
        maxTokens: 4096,
        outputKey: "verifier",
        outputFormat: "text",
        selfCritique: true,
        subscribes: [],
      },
    ],
  },
  {
    label: "Parallel Analysis",
    description: "Two independent analysts then a merger",
    agents: [
      {
        id: "analyst-a",
        name: "Analyst A",
        role: "Analyses from a performance perspective",
        systemPrompt: "Analyse the codebase for performance bottlenecks.",
        dependsOn: [],
        condition: "",
        tools: ["grep_search", "read_file"],
        model: "",
        maxTokens: 4096,
        outputKey: "analyst-a",
        outputFormat: "text",
        selfCritique: false,
        subscribes: [],
      },
      {
        id: "analyst-b",
        name: "Analyst B",
        role: "Analyses from a security perspective",
        systemPrompt: "Analyse the codebase for security vulnerabilities.",
        dependsOn: [],
        condition: "",
        tools: ["grep_search", "read_file"],
        model: "",
        maxTokens: 4096,
        outputKey: "analyst-b",
        outputFormat: "text",
        selfCritique: false,
        subscribes: [],
      },
      {
        id: "merger",
        name: "Merger",
        role: "Combines both analyses into a unified report",
        systemPrompt:
          "Combine {{analyst-a}} and {{analyst-b}} into a prioritised action list.",
        dependsOn: ["analyst-a", "analyst-b"],
        condition: "",
        tools: [],
        model: "",
        maxTokens: 4096,
        outputKey: "merger",
        outputFormat: "text",
        selfCritique: false,
        subscribes: [],
      },
    ],
  },
  {
    label: "Single Agent",
    description: "One agent — simplest possible team",
    agents: [
      {
        id: "agent",
        name: "Agent",
        role: "Completes the task",
        systemPrompt:
          "You are a capable AI agent. Complete the user's request.",
        dependsOn: [],
        condition: "",
        tools: ["edit_file", "create_file", "read_file", "grep_search"],
        model: "",
        maxTokens: 8192,
        outputKey: "agent",
        outputFormat: "text",
        selfCritique: false,
        subscribes: [],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

const teamNameSignal = signal("My Team");
const teamDescSignal = signal("A new agent team");
const agentsSignal = signal<AgentNode[]>([]);
const positionsSignal = signal<Map<string, NodePos>>(new Map());
const selectedIdSignal = signal<string | null>(null);
const showGallerySignal = signal(false);
const saveAckSignal = signal<string | null>(null);
const existingNamesSignal = signal<string[]>([]);

// Dragging state — ephemeral, not signals
let dragging: {
  id: string;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
} | null = null;
let edgeDraw: { fromId: string; curX: number; curY: number } | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function computeInitialPositions(agents: AgentNode[]): Map<string, NodePos> {
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
      for (const nid of adj.get(id) ?? []) {
        const nd = (inDegree.get(nid) ?? 0) - 1;
        inDegree.set(nid, nd);
        if (nd === 0) next.push(nid);
      }
    }
    frontier = next;
  }
  const pos = new Map<string, NodePos>();
  layers.forEach((layer, li) => {
    const y = PAD + li * (NODE_H + V_GAP) + NODE_H / 2;
    layer.forEach((id, ci) => {
      const x = PAD + ci * (NODE_W + H_GAP) + NODE_W / 2;
      pos.set(id, { x, y });
    });
  });
  return pos;
}

function hasCycle(agents: AgentNode[]): boolean {
  const ids = new Set(agents.map((a) => a.id));
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const a of agents) {
    inDeg.set(a.id, 0);
    adj.set(a.id, []);
  }
  for (const a of agents) {
    for (const dep of a.dependsOn) {
      if (!ids.has(dep)) continue; // Skip unknown deps
      inDeg.set(a.id, (inDeg.get(a.id) ?? 0) + 1);
      adj.get(dep)!.push(a.id);
    }
  }
  const queue = [
    ...agents.filter((a) => (inDeg.get(a.id) ?? 0) === 0).map((a) => a.id),
  ];
  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    processed++;
    for (const neighbor of adj.get(node) ?? []) {
      const deg = (inDeg.get(neighbor) ?? 0) - 1;
      inDeg.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }
  return processed < agents.length;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function NodeCard({ agent }: { agent: AgentNode }): JSX.Element {
  const pos = positionsSignal.value.get(agent.id) ?? {
    x: PAD + NODE_W / 2,
    y: PAD + NODE_H / 2,
  };
  const isSelected = selectedIdSignal.value === agent.id;

  function onPointerDown(e: PointerEvent): void {
    if (e.shiftKey) {
      edgeDraw = { fromId: agent.id, curX: e.clientX, curY: e.clientY };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.stopPropagation();
      return;
    }
    selectedIdSignal.value = agent.id;
    dragging = {
      id: agent.id,
      startX: e.clientX,
      startY: e.clientY,
      origX: pos.x,
      origY: pos.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation();
  }

  function onPointerMove(e: PointerEvent): void {
    if (dragging && dragging.id === agent.id) {
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;
      const newPos = new Map(positionsSignal.value);
      newPos.set(agent.id, { x: dragging.origX + dx, y: dragging.origY + dy });
      positionsSignal.value = newPos;
    }
    if (edgeDraw && edgeDraw.fromId === agent.id) {
      edgeDraw.curX = e.clientX;
      edgeDraw.curY = e.clientY;
    }
  }

  function onPointerUp(_e: PointerEvent): void {
    dragging = null;
    if (edgeDraw && edgeDraw.fromId !== agent.id) {
      const fromId = edgeDraw.fromId;
      const updated = agentsSignal.value.map((a) =>
        a.id === agent.id && !a.dependsOn.includes(fromId)
          ? { ...a, dependsOn: [...a.dependsOn, fromId] }
          : a,
      );
      if (!hasCycle(updated)) {
        agentsSignal.value = updated;
      }
    }
    edgeDraw = null;
  }

  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={`
        position:absolute;
        left:${pos.x - NODE_W / 2}px;
        top:${pos.y - NODE_H / 2}px;
        width:${NODE_W}px;
        height:${NODE_H}px;
        border-radius:6px;
        border:2px solid ${isSelected ? "var(--vscode-focusBorder)" : "var(--vscode-panel-border)"};
        background:${isSelected ? "var(--vscode-list-activeSelectionBackground)" : "var(--vscode-editor-background)"};
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        cursor:grab;
        user-select:none;
        box-shadow:${isSelected ? "0 0 0 2px var(--vscode-focusBorder)" : "none"};
        touch-action:none;
      `}
    >
      <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:90%;text-align:center;">
        {agent.name.length > 18 ? agent.name.slice(0, 16) + "…" : agent.name}
      </div>
      <div style="font-size:10px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:90%;text-align:center;">
        {agent.role.length > 22 ? agent.role.slice(0, 20) + "…" : agent.role}
      </div>
    </div>
  );
}

function EdgesSvg(): JSX.Element {
  const agents = agentsSignal.value;
  const positions = positionsSignal.value;
  let maxX = 400;
  let maxY = 300;
  for (const { x, y } of positions.values()) {
    if (x + NODE_W / 2 + PAD > maxX) maxX = x + NODE_W / 2 + PAD;
    if (y + NODE_H / 2 + PAD > maxY) maxY = y + NODE_H / 2 + PAD;
  }

  const paths: JSX.Element[] = [];
  for (const agent of agents) {
    for (const depId of agent.dependsOn) {
      const from = positions.get(depId);
      const to = positions.get(agent.id);
      if (!from || !to) continue;
      const x1 = from.x;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y - NODE_H / 2;
      const midY = (y1 + y2) / 2;
      paths.push(
        <path
          key={`${depId}->${agent.id}`}
          d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
          fill="none"
          stroke="var(--vscode-descriptionForeground)"
          stroke-width={1.5}
          opacity={0.7}
          marker-end="url(#arrow)"
        />,
      );
    }
  }

  return (
    <svg
      style="position:absolute;inset:0;pointer-events:none;overflow:visible;"
      width={maxX}
      height={maxY}
    >
      <defs>
        <marker
          id="arrow"
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
        >
          <path
            d="M0,0 L0,6 L8,3 z"
            fill="var(--vscode-descriptionForeground)"
            opacity={0.7}
          />
        </marker>
      </defs>
      {paths}
    </svg>
  );
}

function AgentSidebar(): JSX.Element | null {
  const selectedId = selectedIdSignal.value;
  if (!selectedId) {
    return (
      <div style="padding:16px;color:var(--vscode-descriptionForeground);font-size:12px;">
        Click a node to edit it. Shift+drag from one node to another to add a
        dependency.
      </div>
    );
  }

  const agent = agentsSignal.value.find((a) => a.id === selectedId);
  if (!agent) return null;

  function update(field: keyof AgentNode, value: unknown): void {
    agentsSignal.value = agentsSignal.value.map((a) =>
      a.id === selectedId ? { ...a, [field]: value } : a,
    );
  }

  function removeDepOn(depId: string): void {
    update(
      "dependsOn",
      agent!.dependsOn.filter((d) => d !== depId),
    );
  }

  function deleteAgent(): void {
    agentsSignal.value = agentsSignal.value
      .filter((a) => a.id !== selectedId)
      .map((a) => ({
        ...a,
        dependsOn: a.dependsOn.filter((d) => d !== selectedId),
      }));
    const newPos = new Map(positionsSignal.value);
    newPos.delete(selectedId);
    positionsSignal.value = newPos;
    selectedIdSignal.value = null;
  }

  const inputStyle =
    "width:100%;box-sizing:border-box;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px 6px;font-size:12px;margin-bottom:8px;";
  const labelStyle =
    "font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:2px;display:block;";

  return (
    <div style="padding:12px;overflow-y:auto;height:100%;box-sizing:border-box;">
      <div style="font-size:12px;font-weight:700;margin-bottom:10px;">
        Edit Agent
      </div>

      <label style={labelStyle}>ID (immutable)</label>
      <div style="font-size:12px;font-family:monospace;background:var(--vscode-textCodeBlock-background);padding:3px 6px;border-radius:3px;margin-bottom:8px;">
        {agent.id}
      </div>

      <label style={labelStyle}>Name</label>
      <input
        style={inputStyle}
        value={agent.name}
        onInput={(e) => update("name", (e.target as HTMLInputElement).value)}
      />

      <label style={labelStyle}>Role</label>
      <input
        style={inputStyle}
        value={agent.role}
        onInput={(e) => update("role", (e.target as HTMLInputElement).value)}
      />

      <label style={labelStyle}>System Prompt</label>
      <textarea
        style={`${inputStyle}height:100px;resize:vertical;font-family:var(--vscode-editor-font-family,monospace);`}
        value={agent.systemPrompt}
        onInput={(e) =>
          update("systemPrompt", (e.target as HTMLTextAreaElement).value)
        }
      />

      <label style={labelStyle}>Model (blank = team default)</label>
      <input
        style={inputStyle}
        value={agent.model}
        onInput={(e) => update("model", (e.target as HTMLInputElement).value)}
      />

      <label style={labelStyle}>Output Format</label>
      <select
        style={inputStyle}
        value={agent.outputFormat}
        onChange={(e) =>
          update(
            "outputFormat",
            (e.target as HTMLSelectElement).value as "text" | "json" | "files",
          )
        }
      >
        <option value="text">text</option>
        <option value="json">json</option>
        <option value="files">files</option>
      </select>

      <label style={labelStyle}>Max Tokens</label>
      <input
        type="number"
        style={inputStyle}
        value={agent.maxTokens}
        onInput={(e) =>
          update("maxTokens", Number((e.target as HTMLInputElement).value))
        }
      />

      <label style={labelStyle}>Self-Critique</label>
      <input
        type="checkbox"
        checked={agent.selfCritique}
        onChange={(e) =>
          update("selfCritique", (e.target as HTMLInputElement).checked)
        }
        style="margin-bottom:8px;"
      />

      {agent.dependsOn.length > 0 && (
        <div>
          <label style={labelStyle}>Depends On</label>
          {agent.dependsOn.map((depId) => (
            <div
              key={depId}
              style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"
            >
              <span style="font-size:11px;font-family:monospace;background:var(--vscode-textCodeBlock-background);padding:2px 5px;border-radius:3px;">
                {depId}
              </span>
              <button
                onClick={() => removeDepOn(depId)}
                style="background:none;border:none;cursor:pointer;color:var(--vscode-errorForeground);font-size:11px;padding:0;"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        onClick={deleteAgent}
        style="width:100%;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);color:var(--vscode-errorForeground);padding:5px;border-radius:3px;cursor:pointer;font-size:11px;margin-top:8px;"
      >
        Delete Agent
      </button>
    </div>
  );
}

function TemplateGallery(): JSX.Element {
  function applyTemplate(tpl: (typeof BUILT_IN_TEMPLATES)[0]): void {
    agentsSignal.value = tpl.agents;
    positionsSignal.value = computeInitialPositions(tpl.agents);
    showGallerySignal.value = false;
    selectedIdSignal.value = null;
  }

  return (
    <div
      style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center;"
      onClick={() => {
        showGallerySignal.value = false;
      }}
    >
      <div
        style="background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:8px;width:480px;max-height:80vh;overflow-y:auto;padding:16px;"
        onClick={(e) => e.stopPropagation()}
      >
        <div style="font-size:14px;font-weight:700;margin-bottom:14px;">
          Template Gallery
        </div>
        {BUILT_IN_TEMPLATES.map((tpl) => (
          <div
            key={tpl.label}
            onClick={() => applyTemplate(tpl)}
            style="border:1px solid var(--vscode-panel-border);border-radius:5px;padding:10px 12px;margin-bottom:8px;cursor:pointer;transition:background .1s;"
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                "var(--vscode-list-hoverBackground)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = "";
            }}
          >
            <div style="font-size:12px;font-weight:600;">{tpl.label}</div>
            <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px;">
              {tpl.description}
            </div>
            <div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px;opacity:.7;">
              {tpl.agents.map((a) => a.name).join(" → ")}
            </div>
          </div>
        ))}
        <button
          onClick={() => {
            showGallerySignal.value = false;
          }}
          style="width:100%;background:none;border:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);padding:6px;border-radius:3px;cursor:pointer;font-size:11px;margin-top:4px;"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TeamBuilderPanel(): JSX.Element {
  const _canvasRef = useRef<HTMLDivElement>(null);

  // Reset all signal state on every mount (panel re-creation) and register
  // the message listener with cleanup — fixes module-level listener leak (#9).
  useEffect(() => {
    teamNameSignal.value = "My Team";
    teamDescSignal.value = "A new agent team";
    agentsSignal.value = [];
    positionsSignal.value = new Map();
    selectedIdSignal.value = null;
    showGallerySignal.value = false;
    saveAckSignal.value = null;
    existingNamesSignal.value = [];

    const handleMessage = (e: MessageEvent): void => {
      const msg = e.data as { type: string };
      if (msg.type === "teamBuilderLoad") {
        const m = msg as TeamBuilderLoadMessage;
        existingNamesSignal.value = m.existingNames;
        if (m.team) {
          teamNameSignal.value = m.team.name;
          teamDescSignal.value = m.team.description;
          agentsSignal.value = m.team.agents.map((a) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            systemPrompt: a.systemPrompt,
            dependsOn: a.dependsOn ?? [],
            condition: a.condition ?? "",
            tools: a.tools ?? [],
            model: a.model ?? "",
            maxTokens: a.maxTokens ?? 4096,
            outputKey: a.outputKey ?? a.id,
            outputFormat: a.outputFormat ?? "text",
            selfCritique: a.selfCritique ?? false,
            subscribes: a.subscribes ?? [],
          }));
          positionsSignal.value = computeInitialPositions(agentsSignal.value);
        }
      } else if (msg.type === "teamBuilderSaveAck") {
        const m = msg as TeamBuilderSaveAckMessage;
        saveAckSignal.value = `Saved to ${m.savedPath}`;
        setTimeout(() => {
          saveAckSignal.value = null;
        }, 3000);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  function addAgent(): void {
    const newId = `agent-${Date.now()}`;
    const newAgent: AgentNode = {
      id: newId,
      name: "New Agent",
      role: "Describe this agent's role",
      systemPrompt: "You are a helpful AI agent.",
      dependsOn: [],
      condition: "",
      tools: [],
      model: "",
      maxTokens: 4096,
      outputKey: newId,
      outputFormat: "text",
      selfCritique: false,
      subscribes: [],
    };
    agentsSignal.value = [...agentsSignal.value, newAgent];
    const newPos = new Map(positionsSignal.value);
    const x = PAD + agentsSignal.value.length * (NODE_W + H_GAP) + NODE_W / 2;
    const y = PAD + NODE_H / 2;
    newPos.set(newId, { x, y });
    positionsSignal.value = newPos;
    selectedIdSignal.value = newId;
  }

  function save(): void {
    getVsCode().postMessage({
      type: "teamBuilderSave",
      team: {
        name: teamNameSignal.value,
        description: teamDescSignal.value,
        version: "1",
        agents: agentsSignal.value,
        defaults: {},
        execution: {
          maxParallel: 3,
          totalTokenBudget: 100000,
          timeoutSeconds: 120,
          retries: 1,
          checkpoints: true,
          mode: "auto",
        },
      },
    });
  }

  // Determine canvas dimensions
  let canvasW = 600;
  let canvasH = 400;
  for (const { x, y } of positionsSignal.value.values()) {
    if (x + NODE_W / 2 + PAD > canvasW) canvasW = x + NODE_W / 2 + PAD;
    if (y + NODE_H / 2 + PAD > canvasH) canvasH = y + NODE_H / 2 + PAD;
  }

  const btnStyle =
    "padding:5px 12px;border:1px solid var(--vscode-panel-border);border-radius:3px;cursor:pointer;font-size:11px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);";
  const inputStyle =
    "background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:3px;padding:4px 6px;font-size:12px;";

  return (
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">
      {/* Toolbar */}
      <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-sideBarSectionHeader-background);flex-shrink:0;">
        <input
          style={`${inputStyle}width:180px;font-weight:600;`}
          value={teamNameSignal.value}
          onInput={(e) => {
            teamNameSignal.value = (e.target as HTMLInputElement).value;
          }}
          placeholder="Team name"
        />
        <input
          style={`${inputStyle}flex:1;`}
          value={teamDescSignal.value}
          onInput={(e) => {
            teamDescSignal.value = (e.target as HTMLInputElement).value;
          }}
          placeholder="Team description"
        />
        <button
          style={btnStyle}
          onClick={() => {
            showGallerySignal.value = true;
          }}
        >
          Templates
        </button>
        <button style={btnStyle} onClick={addAgent}>
          + Agent
        </button>
        <button
          style={`${btnStyle}background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent;`}
          onClick={save}
        >
          Save YAML
        </button>
        {saveAckSignal.value && (
          <span style="font-size:11px;color:var(--vscode-terminal-ansiGreen);">
            {saveAckSignal.value}
          </span>
        )}
      </div>

      {/* Body */}
      <div style="display:flex;flex:1;overflow:hidden;">
        {/* Canvas */}
        <div
          ref={_canvasRef}
          style="flex:1;overflow:auto;position:relative;"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("[data-node]") === null) {
              selectedIdSignal.value = null;
            }
          }}
        >
          <div
            style={`position:relative;width:${canvasW}px;height:${canvasH}px;min-width:100%;min-height:100%;`}
          >
            <EdgesSvg />
            {agentsSignal.value.map((agent) => (
              <div key={agent.id} data-node="true">
                <NodeCard agent={agent} />
              </div>
            ))}
            {agentsSignal.value.length === 0 && (
              <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--vscode-descriptionForeground);font-size:13px;pointer-events:none;">
                Click &quot;+ Agent&quot; or &quot;Templates&quot; to get
                started
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div style="width:280px;flex-shrink:0;border-left:1px solid var(--vscode-panel-border);overflow:hidden;display:flex;flex-direction:column;">
          <AgentSidebar />
        </div>
      </div>

      {showGallerySignal.value && <TemplateGallery />}
    </div>
  );
}

/**
 * Full-screen Champ TUI built with Ink.
 *
 * Layout and interaction follow the shape of a modern agent terminal: fixed
 * header, tab strip, a large content pane and a persistent prompt. The CLI
 * supplies a `TuiRuntime` adapter so this component contains no provider,
 * filesystem or session logic.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import {
  initialTuiState,
  tuiReducer,
  type ChatMessage,
  type ChatRole,
  type EndpointSummary,
  type TuiReviewSummary,
  type TuiScreen,
  type TuiSessionSummary,
} from "./state";
import { buildTranscriptLines, TRANSCRIPT_VIEWPORT_LINES } from "./transcript";
import { shouldSubmitOnEnter } from "./composer";
import { contextBudget, usageLine, usageTotals } from "./insights";
import { mcpSummary } from "./mcp";
import { buildPaletteActions, filterPaletteActions } from "./palette";
import { planProgress, type PlanStepInput } from "./plan";
import { canRedo, canUndo, type RecoverySnapshot } from "./recovery";
import { sessionLineage } from "./session-ops";
import { toolDetailLines } from "./tool-events";
import type { TuiConfigEntry, TuiRuntime } from "./runtime";
import { dedupeEndpointSummaries, resolveTuiSelection } from "./endpoints";
import { filterSessions } from "../session/search";
import { filterModels, modelLabel } from "./model-picker";
import {
  PALETTES,
  detectTheme,
  resolveRuntimeTheme,
  themeEnvForRuntime,
  type Palette,
  type ThemeName,
} from "./theme";
import {
  canonicalChatCommand,
  CHAT_COMMAND_HELP,
  commandSuggestions,
} from "../cli/commands";
import { CONFIG_KEYS } from "../cli/config-editor";

const SCREENS: Array<{ id: TuiScreen; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "providers", label: "Providers" },
  { id: "config", label: "Config" },
  { id: "help", label: "Help" },
  { id: "sessions", label: "Sessions" },
  { id: "review", label: "Review" },
  { id: "tasks", label: "Tasks" },
  { id: "plan", label: "Plan" },
  { id: "context", label: "Context" },
  { id: "usage", label: "Usage" },
  { id: "mcp", label: "MCP" },
];

/** Context-sensitive hints replace a flat key dump in the footer. */
const FOOTER_HINTS: Record<TuiScreen, string> = {
  chat: "? help · Ctrl-P palette · Ctrl-O editor · Ctrl-E tool · Tab screens",
  providers: "↑↓ select · U models · R refresh · P pool · O scope · ? help",
  config: "S set · I editor · ? help",
  help: "? advanced · Esc chat",
  sessions: "F2 rename · F fork · Del delete · Ctrl-T tab · ? help",
  review: "A accept · R reject · ? help",
  tasks: "↑↓ select · A start · X cancel · Esc chat",
  plan: "Enter advance · 1-9 block step · Esc chat",
  context: "C checkpoint · K compact · Z undo · Y redo · Esc chat",
  usage: "↑↓ history · Esc chat",
  mcp: "↑↓ select · R restart · Esc chat",
};

const ROLE_GLYPHS: Record<ChatRole, string> = {
  user: "❯",
  assistant: "◆",
  system: "·",
  tool: "⚡",
  error: "!",
};

function roleColor(role: ChatRole, palette: Palette): string {
  switch (role) {
    case "user":
      return palette.accent;
    case "error":
      return palette.error;
    case "tool":
      return palette.warning;
    case "system":
      return palette.muted;
    default:
      return palette.success;
  }
}

function highlightColor(name: string | undefined, palette: Palette): string {
  switch (name) {
    case "keyword":
    case "selector-tag":
    case "built_in":
      return palette.highlight;
    case "string":
    case "attr":
      return palette.success;
    case "number":
    case "literal":
      return palette.warning;
    case "comment":
      return palette.muted;
    case "title":
    case "function":
      return palette.accent;
    default:
      return palette.text;
  }
}

const SETUP_FIELDS = [
  "name",
  "provider",
  "baseUrl",
  "credentialId",
  "apiKey",
  "model",
] as const;

type SetupField = (typeof SETUP_FIELDS)[number];

interface ApprovalRequest {
  description: string;
  resolve: (approved: boolean) => void;
}

function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

function sanitizePaste(text: string): string {
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "").replace(/\r?\n/g, " ");
}

function Panel({
  title,
  children,
  flexGrow = 1,
  palette,
}: {
  title: string;
  children: ReactNode;
  flexGrow?: number;
  palette: Palette;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={palette.border}
      paddingX={1}
      flexGrow={flexGrow}
      minHeight={6}
    >
      <Text bold color={palette.panelTitle}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function App({ runtime }: { runtime: TuiRuntime }) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(tuiReducer, undefined, () => {
    const endpoints = dedupeEndpointSummaries(
      runtime.initialEndpoints,
      runtime.initialSelection?.endpointId,
    );
    const selection = resolveTuiSelection(
      endpoints,
      runtime.initialSelection?.endpointId,
      runtime.initialSelection?.model
        ? runtime.initialSelection
        : { ...runtime.initialSelection, model: runtime.header.model },
    );
    const staleStatus = selection.stale
      ? `⚠ Assigned model missing: ${selection.model}. Press U to re-pick.`
      : undefined;
    return {
      ...initialTuiState({
        workspace: runtime.header.workspace,
        model: selection.model || runtime.header.model,
        endpoints,
        selectedEndpointId: selection.endpointId,
        selectedModel: selection.model,
        status:
          staleStatus ??
          (endpoints.length === 0
            ? "No endpoints configured — press A to add one"
            : "Ready"),
      }),
      screen: runtime.initialScreen ?? "chat",
    };
  });

  const transcriptWidth = Math.max(20, (process.stdout.columns ?? 80) - 6);
  const transcriptLines = useMemo(
    () => buildTranscriptLines(state.messages, transcriptWidth),
    [state.messages, transcriptWidth],
  );
  const previousLineCount = useRef(transcriptLines.length);
  useEffect(() => {
    const addedLines = Math.max(
      0,
      transcriptLines.length - previousLineCount.current,
    );
    previousLineCount.current = transcriptLines.length;
    if (
      addedLines > 0 ||
      state.totalLines !== transcriptLines.length ||
      state.viewportLines !== TRANSCRIPT_VIEWPORT_LINES
    ) {
      dispatch({
        type: "transcript/metrics",
        totalLines: transcriptLines.length,
        viewportLines: TRANSCRIPT_VIEWPORT_LINES,
        addedLines,
      });
    }
  }, [transcriptLines, state.totalLines, state.viewportLines]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [setupField, setSetupField] = useState<SetupField>("name");
  const [doctorLines, setDoctorLines] = useState<string[]>([]);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [advancedHelp, setAdvancedHelp] = useState(false);
  const [editingEndpointId, setEditingEndpointId] = useState<string | null>(
    null,
  );
  const [theme, setTheme] = useState<ThemeName>(() =>
    resolveRuntimeTheme(runtime),
  );
  const [modelPicker, setModelPicker] = useState<{
    open: boolean;
    endpointId: string;
    filter: string;
    cursor: number;
  }>({ open: false, endpointId: "", filter: "", cursor: 0 });
  const [configDraft, setConfigDraft] = useState<{
    key: string;
    value: string;
    open: boolean;
  }>({ key: CONFIG_KEYS[0].key, value: "", open: false });
  const [configEntries, setConfigEntries] = useState<TuiConfigEntry[]>([]);
  const [sessionPrompt, setSessionPrompt] = useState<{
    kind: "rename" | "fork";
    value: string;
  } | null>(null);
  const [poolPrompt, setPoolPrompt] = useState<{
    kind: "create" | "select";
    value: string;
  } | null>(null);
  const [recoverySnapshots, setRecoverySnapshots] = useState<
    RecoverySnapshot[]
  >([]);
  const [runtimeCommands, setRuntimeCommands] = useState<
    Array<{ name: string; description: string }>
  >([]);
  const [mcpCursor, setMcpCursor] = useState(0);
  const [taskCursor, setTaskCursor] = useState(0);
  const palette = PALETTES[theme];

  // Task prompts are kept outside reducer state because the queue is driven
  // by async turns; the reducer only owns their visible status.
  const queuedPrompts = useRef(
    new Map<string, { text: string; sessionId: string; status: string }>(),
  );
  const activeTurn = useRef<{ id: string; sessionId: string } | null>(null);
  const taskSequence = useRef(0);
  const planSteps = useRef<PlanStepInput[]>([]);
  const runTurnRef = useRef<
    | ((text: string, taskId?: string, sessionId?: string) => Promise<void>)
    | null
  >(null);

  useEffect(() => {
    let alive = true;
    void detectTheme(themeEnvForRuntime(runtime)).then((detected) => {
      if (alive) setTheme(detected);
    });
    return () => {
      alive = false;
    };
  }, [runtime]);

  useEffect(() => {
    let alive = true;
    void runtime.refreshEndpoints().then((endpoints) => {
      if (!alive) return;
      const preferred = runtime.initialSelection?.endpointId;
      const deduped = dedupeEndpointSummaries(endpoints, preferred);
      dispatch({ type: "endpoints/set", endpoints: deduped });
      const selection = resolveTuiSelection(deduped, preferred, {
        endpointId: preferred,
        model: runtime.initialSelection?.model ?? runtime.header.model,
      });
      dispatch({
        type: "selection/set",
        endpointId: selection.endpointId,
        model: selection.model,
        status: selection.stale
          ? `⚠ Assigned model missing: ${selection.model}. Press U to re-pick.`
          : undefined,
      });
    });
    return () => {
      alive = false;
    };
  }, [runtime, runtime.initialSelection, runtime.header.model]);

  useEffect(() => {
    let alive = true;
    if (state.screen === "sessions") {
      if (runtime.listSessions) {
        void runtime.listSessions().then((sessions) => {
          if (alive) dispatch({ type: "sessions/set", sessions });
        });
      }
      if (runtime.listCheckpoints) {
        void runtime.listCheckpoints().then((snapshots) => {
          if (alive) setRecoverySnapshots(snapshots);
        });
      }
    }
    if (state.screen === "review" && runtime.listReviews) {
      void runtime.listReviews().then((reviews) => {
        if (alive) dispatch({ type: "reviews/set", reviews });
      });
    }
    if (state.screen === "config" && runtime.listConfig) {
      void runtime.listConfig().then((entries) => {
        if (alive) setConfigEntries(entries);
      });
    }
    if (state.screen === "context" && runtime.getContext) {
      void runtime.getContext().then((snapshot) => {
        if (alive) dispatch({ type: "context/set", snapshot });
      });
    }
    if (state.screen === "usage" && runtime.listUsage) {
      void runtime.listUsage().then((records) => {
        if (alive) dispatch({ type: "usage/set", records });
      });
    }
    if (state.screen === "plan" && runtime.listPlan) {
      void runtime.listPlan().then((steps) => {
        if (alive) {
          planSteps.current = [...steps];
          dispatch({ type: "plan/set", steps });
        }
      });
    }
    if (state.screen === "mcp" && runtime.listMcpServers) {
      void runtime.listMcpServers().then((servers) => {
        if (alive) {
          dispatch({ type: "mcp/set", servers });
          setMcpCursor(0);
        }
      });
    }
    return () => {
      alive = false;
    };
  }, [runtime, state.screen]);

  useEffect(() => {
    let alive = true;
    if (runtime.listCommands) {
      void runtime.listCommands().then((commands) => {
        if (alive) setRuntimeCommands(commands);
      });
    }
    return () => {
      alive = false;
    };
  }, [runtime]);

  const paletteActions = useMemo(
    () => buildPaletteActions(SCREENS, runtimeCommands),
    [runtimeCommands],
  );
  const visiblePaletteActions = useMemo(
    () => filterPaletteActions(paletteActions, state.paletteQuery),
    [paletteActions, state.paletteQuery],
  );

  const refreshSessions = useCallback(async () => {
    if (!runtime.listSessions) return;
    dispatch({ type: "sessions/set", sessions: await runtime.listSessions() });
  }, [runtime]);

  const suggestions = useMemo(
    () =>
      /^\/[^\s]*$/.test(state.input) ? commandSuggestions(state.input) : [],
    [state.input],
  );

  const runTurn = useCallback(
    async (text: string, taskId?: string, sessionId?: string) => {
      const id = taskId ?? `task-${(taskSequence.current += 1)}`;
      const session = sessionId ?? "main";
      activeTurn.current = { id, sessionId: session };
      if (taskId) dispatch({ type: "tasks/start", sessionId: session });
      dispatch({ type: "turn/start" });
      try {
        const result = await runtime.submit(
          text,
          {
            onText: (chunk) =>
              dispatch({
                type: "message/stream",
                role: "assistant",
                text: chunk,
              }),
            // Legacy callbacks keep existing adapters working. The CLI adapter
            // skips them when it emits structured events, so transcripts never
            // contain the same tool twice.
            onTool: (name, args) =>
              dispatch({
                type: "message/add",
                role: "tool",
                text: `${name} ${truncate(args, 120)}`,
              }),
            onToolResult: (name, output, success) => {
              const firstLine = output.trim().split("\n")[0] || "";
              const summary = firstLine ? ` → ${truncate(firstLine, 80)}` : "";
              dispatch({
                type: "message/add",
                role: success ? "system" : "error",
                text: `${success ? "✓" : "✗"} ${name}${summary}`,
              });
            },
            onToolEvent: (event) => {
              dispatch({ type: "tool/start", event });
              planSteps.current = [
                ...planSteps.current
                  .filter((step) => step.id !== event.id)
                  .map((step) =>
                    step.status === "active"
                      ? { ...step, status: "done" as const }
                      : step,
                  ),
                { id: event.id, text: event.name, status: "active" },
              ];
              dispatch({ type: "plan/set", steps: planSteps.current });
            },
            onToolResultEvent: (event) => {
              dispatch({ type: "tool/result", event });
              planSteps.current = planSteps.current.map((step) =>
                step.id === event.id
                  ? {
                      ...step,
                      status: event.success
                        ? ("done" as const)
                        : ("blocked" as const),
                    }
                  : step,
              );
              if (!planSteps.current.some((step) => step.status === "active")) {
                const next = planSteps.current.find(
                  (step) => step.status === "pending",
                );
                if (next) next.status = "active";
              }
              dispatch({ type: "plan/set", steps: planSteps.current });
            },
            onPlan: (steps) => {
              planSteps.current = [...steps];
              dispatch({ type: "plan/set", steps });
            },
            onUsage: (record) => dispatch({ type: "usage/add", record }),
            onContext: (snapshot) =>
              dispatch({ type: "context/set", snapshot }),
            onError: (message) =>
              dispatch({ type: "message/add", role: "error", text: message }),
            onDone: (summary) => {
              const telemetryParts: string[] = [];
              telemetryParts.push(
                `tools=${summary.tools}${summary.toolDurationMs !== undefined ? ` (${summary.toolDurationMs}ms)` : ""}`,
              );
              let tokenStr = `tokens in=${summary.inputTokens}`;
              if (summary.cachedInputTokens) {
                tokenStr += ` (cached: ${summary.cachedInputTokens})`;
              }
              tokenStr += ` out=${summary.outputTokens}`;
              if (summary.reasoningTokens) {
                tokenStr += ` (reasoning: ${summary.reasoningTokens})`;
              }
              telemetryParts.push(tokenStr);

              if (summary.contextWindow) {
                telemetryParts.push(
                  `context=${summary.contextUsed?.toLocaleString() ?? 0}/${summary.contextWindow.toLocaleString()} (${summary.contextPercent ?? 0}% used, ${summary.contextRemaining?.toLocaleString() ?? 0} left)`,
                );
              }
              if (summary.costUsd !== undefined) {
                if (summary.costKnown && summary.costUsd !== null) {
                  telemetryParts.push(`cost=$${summary.costUsd.toFixed(4)}`);
                } else {
                  telemetryParts.push(
                    `cost=unknown (${summary.pricingVersion ?? "2026-11-01"})`,
                  );
                }
              }
              if (summary.durationMs !== undefined) {
                const sec = `${(summary.durationMs / 1000).toFixed(2)}s`;
                const ttft =
                  summary.firstTokenMs !== undefined
                    ? ` (TTFT: ${summary.firstTokenMs}ms)`
                    : "";
                telemetryParts.push(`latency=${sec}${ttft}`);
              }
              if (summary.model) {
                telemetryParts.push(`model=${summary.model}`);
              }

              dispatch({
                type: "message/add",
                role: "system",
                text: `[turn] ${telemetryParts.join(" · ")}`,
              });

              const shortStatus = `in=${summary.inputTokens}${summary.cachedInputTokens ? `(c:${summary.cachedInputTokens})` : ""} out=${summary.outputTokens}${summary.costUsd != null ? ` $${summary.costUsd.toFixed(4)}` : ""} · ${summary.durationMs ? `${(summary.durationMs / 1000).toFixed(1)}s` : "done"}`;
              dispatch({
                type: "status/set",
                text: shortStatus,
              });
            },
          },
          (description) =>
            new Promise<boolean>((resolve) => {
              setApproval({ description, resolve });
            }),
        );
        if (result.aborted) {
          dispatch({ type: "status/set", text: "Aborted" });
        } else if (result.error) {
          dispatch({
            type: "status/set",
            text: `Error: ${truncate(result.error, 90)}`,
          });
        }
      } catch (err) {
        dispatch({
          type: "message/add",
          role: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        activeTurn.current = null;
        if (taskId) {
          dispatch({ type: "tasks/finish", id, status: "done" });
        }
        dispatch({ type: "turn/stop" });
      }
    },
    [runtime],
  );
  runTurnRef.current = runTurn;

  const submit = useCallback(
    async (override?: string, background = false) => {
      const text = (override ?? state.input).trim();
      if (!text) return;

      if (!override) {
        if (text === "/exit" || text === "/quit" || text === "/q") {
          runtime.exit();
          exit();
          return;
        }
        if (text === "/clear") {
          dispatch({ type: "messages/clear" });
          return;
        }
        if (text === "/help") {
          dispatch({ type: "screen/set", screen: "help" });
          return;
        }
        const canonical = canonicalChatCommand(text);
        if (text === "/providers" || canonical === "/model") {
          dispatch({ type: "screen/set", screen: "providers" });
          return;
        }
        if (canonical === "/sessions") {
          dispatch({ type: "screen/set", screen: "sessions" });
          return;
        }
        if (text.startsWith("/") && runtime.command) {
          const commandText = canonical
            ? [canonical, ...text.trim().split(/\s+/).slice(1)].join(" ")
            : text;
          const output = await runtime.command(commandText);
          if (output !== null) {
            dispatch({ type: "message/add", role: "system", text: output });
            return;
          }
        }
      }

      const sessionId =
        state.sessionTabs[state.activeSessionTab] ??
        state.activeSessionId ??
        "main";
      const id = `task-${(taskSequence.current += 1)}`;
      queuedPrompts.current.set(id, {
        text,
        sessionId,
        status: activeTurn.current || background ? "queued" : "running",
      });
      dispatch({
        type: "tasks/enqueue",
        task: { id, sessionId, label: truncate(text, 42), background },
      });
      if (!activeTurn.current && !background) {
        queuedPrompts.current.get(id)!.status = "running";
        await runTurn(text, id, sessionId);
      } else {
        const waiting = [...queuedPrompts.current.values()].filter(
          (entry) => entry.status === "queued",
        ).length;
        dispatch({
          type: "status/set",
          text: `Queued ${waiting} task(s) for ${sessionId}`,
        });
      }
    },
    [
      exit,
      runtime,
      runTurn,
      state.activeSessionId,
      state.activeSessionTab,
      state.input,
      state.sessionTabs,
    ],
  );

  useEffect(() => {
    if (state.busy || activeTurn.current) return;
    for (const [id, entry] of queuedPrompts.current) {
      if (entry.status === "queued") {
        entry.status = "running";
        void runTurnRef.current?.(entry.text, id, entry.sessionId);
        return;
      }
    }
  }, [state.busy]);

  const openSetup = useCallback(
    (target?: EndpointSummary) => {
      setEditingEndpointId(target?.id ?? null);
      setSetupField(target ? "model" : "name");
      dispatch({ type: "setup/open" });
      if (target) {
        dispatch({ type: "setup/change", field: "name", value: target.name });
        dispatch({
          type: "setup/change",
          field: "provider",
          value: target.provider,
        });
        dispatch({
          type: "setup/change",
          field: "baseUrl",
          value: target.baseUrl,
        });
        dispatch({
          type: "setup/change",
          field: "model",
          value: state.selectedModel ?? target.models[0] ?? "",
        });
      }
    },
    [state.selectedModel],
  );

  const saveEndpoint = useCallback(async () => {
    if (state.setup.saving) return;
    dispatch({ type: "setup/submit" });
    if (!state.setup.name.trim()) return;

    const input = {
      name: state.setup.name,
      provider: state.setup.provider,
      baseUrl: state.setup.baseUrl || undefined,
      credentialId: state.setup.credentialId || undefined,
      apiKey: state.setup.apiKey || undefined,
      model: state.setup.model || undefined,
    };
    try {
      const message = editingEndpointId
        ? await runtime.updateEndpoint(editingEndpointId, input)
        : await runtime.addEndpoint(input);
      const refreshed = await runtime.refreshEndpoints();
      const endpoints = dedupeEndpointSummaries(
        refreshed,
        editingEndpointId ?? undefined,
      );
      dispatch({ type: "endpoints/set", endpoints });
      dispatch({ type: "setup/result", status: message });
      setSetupField("name");
      setEditingEndpointId(null);

      // The registry probes /v1/models during add/update. Offer the picker
      // immediately so a stale or manually typed model gets re-confirmed.
      const target =
        endpoints.find((item) => item.id === editingEndpointId) ??
        endpoints[endpoints.length - 1];
      if (target && target.models.length > 0) {
        setModelPicker({
          open: true,
          endpointId: target.id,
          filter: "",
          cursor: 0,
        });
      }
    } catch (err) {
      dispatch({
        type: "setup/result",
        status: err instanceof Error ? err.message : String(err),
        error: true,
      });
    }
  }, [editingEndpointId, runtime, state.setup]);

  const resumeSession = useCallback(
    async (id: string) => {
      if (!runtime.resumeSession) return;
      try {
        const resumed = await runtime.resumeSession(id);
        dispatch({ type: "messages/clear" });
        for (const message of resumed.messages) {
          dispatch({
            type: "message/add",
            role: message.role,
            text: message.text,
          });
        }
        dispatch({ type: "transcript/bottom" });
        dispatch({ type: "status/set", text: resumed.summary });
        dispatch({ type: "sessions/tab/add", id });
        await refreshSessions();
      } catch (err) {
        dispatch({
          type: "status/set",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [runtime, refreshSessions],
  );

  const sessionOperation = useCallback(
    async (kind: "rename" | "fork" | "delete", value = "") => {
      const selected = filterSessions(state.sessions, state.sessionFilter)[
        state.sessionCursor
      ];
      if (!selected) return;
      try {
        if (kind === "rename") {
          if (!runtime.renameSession) return;
          dispatch({
            type: "status/set",
            text: await runtime.renameSession(selected.id, value),
          });
          dispatch({
            type: "sessions/rename",
            id: selected.id,
            label: value,
          });
        } else if (kind === "fork") {
          if (!runtime.forkSession) return;
          const result = await runtime.forkSession(selected.id, value);
          const newId = /to (\S+)/.exec(result)?.[1] ?? `fork-${Date.now()}`;
          dispatch({
            type: "sessions/fork",
            id: selected.id,
            newId,
            label: value || `${selected.label} fork`,
          });
          dispatch({ type: "status/set", text: result });
        } else {
          if (!runtime.deleteSession) return;
          dispatch({
            type: "status/set",
            text: await runtime.deleteSession(selected.id),
          });
          dispatch({ type: "sessions/delete", id: selected.id });
        }
        setSessionPrompt(null);
        await refreshSessions();
      } catch (err) {
        dispatch({
          type: "status/set",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [
      refreshSessions,
      runtime,
      state.sessionCursor,
      state.sessionFilter,
      state.sessions,
    ],
  );

  const poolOperation = useCallback(
    async (kind: "create" | "select", value: string) => {
      try {
        if (kind === "create") {
          if (!runtime.addPool) return;
          const [name, ids] = value.split(":", 2);
          const endpointIds = (ids ?? "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
          if (!name?.trim() || endpointIds.length === 0) {
            dispatch({
              type: "status/set",
              text: "Use <name>:<endpoint-id,...> to create a pool",
            });
            return;
          }
          dispatch({
            type: "status/set",
            text: await runtime.addPool(name.trim(), endpointIds),
          });
        } else {
          if (!runtime.selectPoolScope) return;
          const pools = (await runtime.listPools?.()) ?? [];
          const pool =
            pools.find((item) => item.id === value.trim()) ??
            pools.find((item) => item.name === value.trim());
          if (!pool) {
            dispatch({
              type: "status/set",
              text: `Pool "${value.trim()}" not found`,
            });
            return;
          }
          dispatch({
            type: "status/set",
            text: await runtime.selectPoolScope(pool.id),
          });
        }
        setPoolPrompt(null);
      } catch (err) {
        dispatch({
          type: "status/set",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [runtime],
  );

  const recoveryOperation = useCallback(
    async (
      kind: "checkpoint" | "compact" | "undo" | "redo" | "rewind",
      id?: string,
    ) => {
      try {
        if (kind === "checkpoint" || kind === "compact") {
          if (!runtime.command) return;
          const command =
            kind === "checkpoint"
              ? `/checkpoint ${id ?? "tui checkpoint"}`
              : "/compact";
          const message = await runtime.command(command);
          if (message) dispatch({ type: "status/set", text: message });
          if (runtime.listCheckpoints) {
            const snapshots = await runtime.listCheckpoints();
            setRecoverySnapshots(snapshots);
            const newest = snapshots[snapshots.length - 1];
            if (newest) dispatch({ type: "recovery/record", snapshot: newest });
          }
          return;
        }
        if (!runtime.rewindTo) return;
        const target =
          kind === "undo"
            ? state.recovery.past[state.recovery.past.length - 1]
            : kind === "redo"
              ? state.recovery.future[0]
              : (state.recovery.past.find((item) => item.id === id) ??
                recoverySnapshots.find((item) => item.id === id));
        if (!target) return;
        const checkpointId = target.checkpointId ?? target.id;
        dispatch({
          type: "status/set",
          text: await runtime.rewindTo(checkpointId),
        });
        if (kind === "undo") dispatch({ type: "recovery/undo" });
        else if (kind === "redo") dispatch({ type: "recovery/redo" });
        else dispatch({ type: "recovery/rewind", id: target.id });
      } catch (err) {
        dispatch({
          type: "status/set",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [recoverySnapshots, runtime, state.recovery],
  );

  const reviewAction = useCallback(
    async (kind: "accept" | "reject", id: string) => {
      const action =
        kind === "accept" ? runtime.acceptReview : runtime.rejectReview;
      if (!action) return;
      try {
        const message = await action(id);
        dispatch({ type: "status/set", text: message });
        if (runtime.listReviews) {
          dispatch({
            type: "reviews/set",
            reviews: await runtime.listReviews(),
          });
        }
      } catch (err) {
        dispatch({
          type: "status/set",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [runtime],
  );

  const restartMcp = useCallback(
    async (name: string) => {
      if (!runtime.restartMcpServer) return;
      dispatch({ type: "mcp/restarting", name });
      try {
        dispatch({
          type: "status/set",
          text: await runtime.restartMcpServer(name),
        });
      } catch (err) {
        dispatch({
          type: "mcp/health",
          name,
          health: "down",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (runtime.listMcpServers) {
        dispatch({ type: "mcp/set", servers: await runtime.listMcpServers() });
      }
    },
    [runtime],
  );

  const saveConfig = useCallback(async () => {
    if (!runtime.setConfig) return;
    try {
      const message = await runtime.setConfig(
        configDraft.key,
        configDraft.value,
      );
      dispatch({ type: "status/set", text: message });
      setConfigDraft({ ...configDraft, value: "", open: false });
      if (runtime.listConfig) setConfigEntries(await runtime.listConfig());
    } catch (err) {
      dispatch({
        type: "status/set",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }, [runtime, configDraft]);

  const visibleSessions = useMemo(
    () => filterSessions(state.sessions, state.sessionFilter),
    [state.sessions, state.sessionFilter],
  );

  useInput((input, key) => {
    if (approval) {
      const answer = input.trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        approval.resolve(true);
        setApproval(null);
      } else if (
        answer === "n" ||
        answer === "no" ||
        key.return ||
        key.escape
      ) {
        approval.resolve(false);
        setApproval(null);
      }
      return;
    }

    if (key.ctrl && input.toLowerCase() === "c") {
      if (state.busy) {
        runtime.abort();
      } else {
        runtime.exit();
        exit();
      }
      return;
    }

    if (key.ctrl && input.toLowerCase() === "p") {
      dispatch({ type: state.paletteOpen ? "palette/close" : "palette/open" });
      return;
    }

    if (state.paletteOpen) {
      const selected =
        visiblePaletteActions[
          Math.min(
            state.paletteCursor,
            Math.max(0, visiblePaletteActions.length - 1),
          )
        ];
      if (key.escape) {
        dispatch({ type: "palette/close" });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: "palette/cursor", delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: "palette/cursor", delta: 1 });
        return;
      }
      if (key.return && selected) {
        if (selected.screen) {
          dispatch({ type: "screen/set", screen: selected.screen });
        } else {
          const name = selected.id.replace(/^command:/, "");
          dispatch({ type: "input/set", value: `/${name} ` });
          dispatch({ type: "screen/set", screen: "chat" });
        }
        dispatch({ type: "palette/close" });
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({
          type: "palette/query",
          value: state.paletteQuery.slice(0, -1),
        });
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        dispatch({ type: "palette/query", value: state.paletteQuery + input });
      }
      return;
    }

    if (poolPrompt) {
      if (key.escape) {
        setPoolPrompt(null);
        return;
      }
      if (key.return) {
        void poolOperation(poolPrompt.kind, poolPrompt.value);
        return;
      }
      if (key.backspace || key.delete) {
        setPoolPrompt({
          ...poolPrompt,
          value: poolPrompt.value.slice(0, -1),
        });
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setPoolPrompt({
          ...poolPrompt,
          value: poolPrompt.value + input,
        });
      }
      return;
    }

    if (sessionPrompt) {
      if (key.escape) {
        setSessionPrompt(null);
        return;
      }
      if (key.return) {
        void sessionOperation(sessionPrompt.kind, sessionPrompt.value);
        return;
      }
      if (key.backspace || key.delete) {
        setSessionPrompt({
          ...sessionPrompt,
          value: sessionPrompt.value.slice(0, -1),
        });
        return;
      }
      if (input.length > 0 && !key.ctrl && !key.meta) {
        setSessionPrompt({
          ...sessionPrompt,
          value: sessionPrompt.value + input,
        });
      }
      return;
    }

    if (key.escape) {
      if (modelPicker.open) {
        setModelPicker({ open: false, endpointId: "", filter: "", cursor: 0 });
        return;
      }
      if (configDraft.open) {
        setConfigDraft({ ...configDraft, open: false, value: "" });
        return;
      }
      if (state.screen === "chat" && suggestions.length > 0) {
        dispatch({ type: "input/set", value: "" });
        setCompletionIndex(0);
        return;
      }
      if (state.setup.open) {
        dispatch({ type: "setup/cancel" });
        return;
      }
      if (state.screen === "chat" && state.busy) {
        runtime.abort();
        return;
      }
      dispatch({ type: "screen/set", screen: "chat" });
      return;
    }

    if (state.screen === "chat" && suggestions.length > 0) {
      const selected =
        suggestions[Math.min(completionIndex, suggestions.length - 1)];
      if (key.upArrow) {
        setCompletionIndex(
          (index) => (index + suggestions.length - 1) % suggestions.length,
        );
        return;
      }
      if (key.downArrow) {
        setCompletionIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (key.tab || (key.return && state.input.trim() !== selected.name)) {
        dispatch({ type: "input/set", value: `${selected.name} ` });
        setCompletionIndex(0);
        return;
      }
    }

    const setupOpen = state.screen === "providers" && state.setup.open;
    if (setupOpen) {
      const index = SETUP_FIELDS.indexOf(setupField);
      if (key.tab) {
        setSetupField(SETUP_FIELDS[(index + 1) % SETUP_FIELDS.length]);
        return;
      }
      if (key.return) {
        if (setupField === "model") void saveEndpoint();
        else
          setSetupField(
            SETUP_FIELDS[Math.min(index + 1, SETUP_FIELDS.length - 1)],
          );
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({
          type: "setup/change",
          field: setupField,
          value: state.setup[setupField].slice(0, -1),
        });
        return;
      }
      if (
        input.length > 0 &&
        !key.ctrl &&
        !key.meta &&
        !input.startsWith("\x1b")
      ) {
        const clean = sanitizePaste(input);
        if (clean.length > 0) {
          dispatch({
            type: "setup/change",
            field: setupField,
            value: state.setup[setupField] + clean,
          });
        }
        return;
      }
      return;
    }

    if (
      input === "?" &&
      !state.busy &&
      (state.screen !== "chat" || state.input === "")
    ) {
      setAdvancedHelp((shown) => !shown);
      dispatch({ type: "screen/set", screen: "help" });
      return;
    }

    if (key.tab && !(state.screen === "config" && configDraft.open)) {
      dispatch({ type: "screen/next" });
      return;
    }

    if (state.screen === "chat") {
      if (key.pageUp) {
        dispatch({
          type: "transcript/scroll",
          delta: -TRANSCRIPT_VIEWPORT_LINES,
        });
        return;
      }
      if (key.pageDown) {
        dispatch({
          type: "transcript/scroll",
          delta: TRANSCRIPT_VIEWPORT_LINES,
        });
        return;
      }
      // Ink 3's key object has no home/end flags and strips the leading ESC,
      // so \x1b[H arrives as "[H" with key.meta set.
      if (key.meta && (input === "[H" || input === "OH")) {
        dispatch({ type: "transcript/top" });
        return;
      }
      if (key.meta && (input === "[F" || input === "OF")) {
        dispatch({ type: "transcript/bottom" });
        return;
      }
      if (key.ctrl && input === "e") {
        const lastTool = [...state.messages]
          .reverse()
          .find((message) => message.role === "tool");
        if (lastTool) dispatch({ type: "tool/toggle", id: lastTool.id });
        return;
      }
      if (key.ctrl && input === "o" && runtime.openExternalEditor) {
        void runtime
          .openExternalEditor(state.input)
          .then((edited) => {
            if (edited !== null) {
              dispatch({ type: "composer/replace", text: edited });
            }
          })
          .catch((err: unknown) =>
            dispatch({
              type: "status/set",
              text: err instanceof Error ? err.message : String(err),
            }),
          );
        return;
      }
      if (key.return) {
        if (shouldSubmitOnEnter({ ctrl: key.ctrl, meta: key.meta })) {
          void submit();
        } else {
          dispatch({ type: "composer/insert", text: "\n" });
        }
        return;
      }
      if (key.backspace) {
        dispatch({ type: "composer/backspace" });
        return;
      }
      if (key.delete) {
        dispatch({ type: "composer/delete" });
        return;
      }
      if (key.leftArrow) {
        dispatch({ type: "composer/move", move: "left" });
        return;
      }
      if (key.rightArrow) {
        dispatch({ type: "composer/move", move: "right" });
        return;
      }
      if (key.upArrow || key.downArrow) {
        if (state.input === "") {
          dispatch({
            type: "transcript/scroll",
            delta: key.upArrow ? -1 : 1,
          });
        } else if (state.composer.lines.length > 1) {
          dispatch({
            type: "composer/move",
            move: key.upArrow ? "up" : "down",
          });
        } else {
          dispatch({ type: key.upArrow ? "history/prev" : "history/next" });
        }
        return;
      }
      if (
        state.busy ||
        input.length === 0 ||
        key.ctrl ||
        key.meta ||
        input.startsWith("\x1b")
      ) {
        return;
      }
      dispatch({ type: "composer/insert", text: input });
      setCompletionIndex(0);
      return;
    }

    if (state.screen === "providers") {
      const endpoint = state.endpoints[state.cursor];
      if (modelPicker.open) {
        const candidates = endpoint
          ? filterModels(endpoint.models, modelPicker.filter)
          : [];
        if (key.escape) {
          if (modelPicker.filter) {
            setModelPicker((picker) => ({ ...picker, filter: "", cursor: 0 }));
          } else {
            setModelPicker({
              open: false,
              endpointId: "",
              filter: "",
              cursor: 0,
            });
          }
          return;
        }
        if (input === "M" && !modelPicker.filter && endpoint) {
          setModelPicker({
            open: false,
            endpointId: "",
            filter: "",
            cursor: 0,
          });
          openSetup(endpoint);
          return;
        }
        if (key.upArrow) {
          setModelPicker((picker) => ({
            ...picker,
            cursor: Math.max(0, picker.cursor - 1),
          }));
          return;
        }
        if (key.downArrow) {
          setModelPicker((picker) => ({
            ...picker,
            cursor: Math.min(candidates.length - 1, picker.cursor + 1),
          }));
          return;
        }
        if (key.return) {
          const model = candidates[modelPicker.cursor];
          if (endpoint && model) {
            setModelPicker({
              open: false,
              endpointId: "",
              filter: "",
              cursor: 0,
            });
            void runtime
              .selectModel(endpoint.id, model)
              .then((message) => {
                dispatch({
                  type: "model/select",
                  endpointId: endpoint.id,
                  model,
                });
                dispatch({ type: "status/set", text: message });
              })
              .catch((err: unknown) =>
                dispatch({
                  type: "status/set",
                  text: err instanceof Error ? err.message : String(err),
                }),
              );
          }
          return;
        }
        if (key.backspace || key.delete) {
          setModelPicker((picker) => ({
            ...picker,
            filter: picker.filter.slice(0, -1),
            cursor: 0,
          }));
          return;
        }
        if (
          input.length > 0 &&
          !key.ctrl &&
          !key.meta &&
          !input.startsWith("\x1b")
        ) {
          if (
            input.length === 1 &&
            /^[1-9]$/.test(input) &&
            !modelPicker.filter
          ) {
            const model = candidates[Number(input) - 1];
            if (endpoint && model) {
              setModelPicker({
                open: false,
                endpointId: "",
                filter: "",
                cursor: 0,
              });
              void runtime
                .selectModel(endpoint.id, model)
                .then((message) => {
                  dispatch({
                    type: "model/select",
                    endpointId: endpoint.id,
                    model,
                  });
                  dispatch({ type: "status/set", text: message });
                })
                .catch((err: unknown) =>
                  dispatch({
                    type: "status/set",
                    text: err instanceof Error ? err.message : String(err),
                  }),
                );
            }
            return;
          }
          const clean = sanitizePaste(input);
          if (clean.length > 0) {
            setModelPicker((picker) => ({
              ...picker,
              filter: picker.filter + clean,
              cursor: 0,
            }));
          }
        }
        return;
      }

      if (key.upArrow) dispatch({ type: "endpoints/cursor", delta: -1 });
      else if (key.downArrow) dispatch({ type: "endpoints/cursor", delta: 1 });
      else if (input.toLowerCase() === "a") openSetup();
      else if (input.toLowerCase() === "e" && endpoint) openSetup(endpoint);
      else if (input.toLowerCase() === "u") {
        if (endpoint) {
          setModelPicker({
            open: true,
            endpointId: endpoint.id,
            filter: "",
            cursor: Math.max(
              0,
              endpoint.models.indexOf(state.selectedModel ?? ""),
            ),
          });
        }
      } else if (input.toLowerCase() === "r") {
        void runtime
          .refreshEndpoints()
          .then((endpoints) => dispatch({ type: "endpoints/set", endpoints }))
          .catch((err: unknown) =>
            dispatch({
              type: "status/set",
              text: err instanceof Error ? err.message : String(err),
            }),
          );
      } else if (input.toLowerCase() === "p" && runtime.addPool) {
        setPoolPrompt({ kind: "create", value: "" });
      } else if (input.toLowerCase() === "o" && runtime.selectPoolScope) {
        setPoolPrompt({ kind: "select", value: "" });
      } else if (input.toLowerCase() === "t") {
        if (endpoint) {
          void runtime
            .testEndpoint(endpoint.id)
            .then((message) => dispatch({ type: "status/set", text: message }))
            .catch((err: unknown) =>
              dispatch({
                type: "status/set",
                text: err instanceof Error ? err.message : String(err),
              }),
            );
        }
      }
      return;
    }

    if (state.screen === "config") {
      if (configDraft.open) {
        const index = CONFIG_KEYS.findIndex(
          (entry) => entry.key === configDraft.key,
        );
        if (key.tab) {
          const next = CONFIG_KEYS[(index + 1) % CONFIG_KEYS.length];
          setConfigDraft({ ...configDraft, key: next.key, value: "" });
          return;
        }
        if (key.return) {
          void saveConfig();
          return;
        }
        if (key.backspace || key.delete) {
          setConfigDraft({
            ...configDraft,
            value: configDraft.value.slice(0, -1),
          });
          return;
        }
        if (
          input.length > 0 &&
          !key.ctrl &&
          !key.meta &&
          !input.startsWith("\x1b")
        ) {
          const clean = sanitizePaste(input);
          if (clean.length > 0) {
            setConfigDraft({
              ...configDraft,
              value: configDraft.value + clean,
            });
          }
        }
        return;
      }
      if (input.toLowerCase() === "s") {
        setConfigDraft({ key: CONFIG_KEYS[0].key, value: "", open: true });
        return;
      }
      if (input.toLowerCase() === "i") {
        if (runtime.editConfig) {
          void runtime
            .editConfig()
            .then((message) => dispatch({ type: "status/set", text: message }))
            .catch((err: unknown) =>
              dispatch({
                type: "status/set",
                text: err instanceof Error ? err.message : String(err),
              }),
            );
        }
        return;
      }
      if (input.toLowerCase() === "v") {
        void runtime
          .validate()
          .then((lines) => {
            dispatch({
              type: "diagnostics/set",
              lines: lines.length ? lines : ["configuration is valid"],
            });
            dispatch({ type: "status/set", text: "Validation complete" });
          })
          .catch((err: unknown) =>
            dispatch({
              type: "status/set",
              text: err instanceof Error ? err.message : String(err),
            }),
          );
      } else if (input.toLowerCase() === "d") {
        void runtime
          .doctor()
          .then((report) => {
            setDoctorLines(report.lines);
            dispatch({
              type: "diagnostics/set",
              lines: report.lines,
            });
            dispatch({
              type: "status/set",
              text: report.healthy
                ? "Doctor: healthy"
                : "Doctor: problems found",
            });
          })
          .catch((err: unknown) =>
            dispatch({
              type: "status/set",
              text: err instanceof Error ? err.message : String(err),
            }),
          );
      } else if (input.toLowerCase() === "e") {
        void runtime
          .exportRedacted()
          .then(() =>
            dispatch({ type: "status/set", text: "Redacted export ready" }),
          )
          .catch((err: unknown) =>
            dispatch({
              type: "status/set",
              text: err instanceof Error ? err.message : String(err),
            }),
          );
      }
    }

    if (state.screen === "sessions") {
      const selected = state.sessions[state.sessionCursor];
      if (key.upArrow) dispatch({ type: "sessions/cursor", delta: -1 });
      else if (key.downArrow) dispatch({ type: "sessions/cursor", delta: 1 });
      else if (key.return && selected) void resumeSession(selected.id);
      else if (key.ctrl && input === "u") {
        dispatch({ type: "sessions/filter", value: "" });
      } else if (state.sessionFilter === "" && selected && input === "N") {
        setSessionPrompt({ kind: "rename", value: selected.label });
      } else if (state.sessionFilter === "" && selected && input === "F") {
        setSessionPrompt({ kind: "fork", value: `${selected.label} fork` });
      } else if (
        state.sessionFilter === "" &&
        selected &&
        (key.delete || input === "D")
      ) {
        void sessionOperation("delete");
      } else if (
        state.sessionFilter === "" &&
        selected &&
        ((key.ctrl && input === "t") || input === "T")
      ) {
        dispatch({ type: "sessions/tab/add", id: selected.id });
      } else if (state.sessionFilter === "" && input === "[") {
        dispatch({ type: "sessions/tab/move", delta: -1 });
      } else if (state.sessionFilter === "" && input === "]") {
        dispatch({ type: "sessions/tab/move", delta: 1 });
      } else if (key.backspace || key.delete) {
        dispatch({
          type: "sessions/filter",
          value: state.sessionFilter.slice(0, -1),
        });
      } else if (input.length === 1 && !key.ctrl && !key.meta) {
        dispatch({
          type: "sessions/filter",
          value: state.sessionFilter + input,
        });
      }
      return;
    }

    if (state.screen === "tasks") {
      const selected =
        state.tasks[Math.min(taskCursor, Math.max(0, state.tasks.length - 1))];
      if (key.upArrow) {
        setTaskCursor((cursor) => Math.max(0, cursor - 1));
      } else if (key.downArrow) {
        setTaskCursor((cursor) =>
          Math.min(Math.max(0, state.tasks.length - 1), cursor + 1),
        );
      } else if (input.toLowerCase() === "a" && selected) {
        dispatch({ type: "tasks/start", sessionId: selected.sessionId });
      } else if (input.toLowerCase() === "x" && selected) {
        dispatch({
          type: "tasks/finish",
          id: selected.id,
          status: "cancelled",
        });
      }
      return;
    }

    if (state.screen === "plan") {
      if (key.return) dispatch({ type: "plan/advance" });
      else if (/^[1-9]$/.test(input)) {
        const step = state.plan[Number(input) - 1];
        if (step)
          dispatch({ type: "plan/step", id: step.id, status: "blocked" });
      }
      return;
    }

    if (state.screen === "context") {
      if (key.upArrow) {
        setTaskCursor((cursor) => Math.max(0, cursor - 1));
      } else if (key.downArrow) {
        setTaskCursor((cursor) =>
          Math.min(Math.max(0, recoverySnapshots.length - 1), cursor + 1),
        );
      } else if (key.return) {
        const snapshot = recoverySnapshots[taskCursor];
        if (snapshot) void recoveryOperation("rewind", snapshot.id);
      } else if (input.toLowerCase() === "c") {
        void recoveryOperation("checkpoint");
      } else if (input.toLowerCase() === "k") {
        void recoveryOperation("compact");
      } else if (input.toLowerCase() === "z") {
        void recoveryOperation("undo");
      } else if (input.toLowerCase() === "y") {
        void recoveryOperation("redo");
      }
      return;
    }

    if (state.screen === "usage") {
      if (key.upArrow) setTaskCursor((cursor) => Math.max(0, cursor - 1));
      else if (key.downArrow) {
        setTaskCursor((cursor) =>
          Math.min(Math.max(0, state.usage.length - 1), cursor + 1),
        );
      }
      return;
    }

    if (state.screen === "mcp") {
      const server =
        state.mcpServers[
          Math.min(mcpCursor, Math.max(0, state.mcpServers.length - 1))
        ];
      if (key.upArrow) setMcpCursor((cursor) => Math.max(0, cursor - 1));
      else if (key.downArrow) {
        setMcpCursor((cursor) =>
          Math.min(Math.max(0, state.mcpServers.length - 1), cursor + 1),
        );
      } else if (input.toLowerCase() === "r" && server) {
        void restartMcp(server.name);
      }
      return;
    }

    if (state.screen === "review") {
      if (key.upArrow) dispatch({ type: "reviews/cursor", delta: -1 });
      else if (key.downArrow) dispatch({ type: "reviews/cursor", delta: 1 });
      else if (input.toLowerCase() === "a") {
        const selected = state.reviews[state.reviewCursor];
        if (selected) void reviewAction("accept", selected.id);
      } else if (input.toLowerCase() === "r") {
        const selected = state.reviews[state.reviewCursor];
        if (selected) void reviewAction("reject", selected.id);
      }
    }
  });

  const scrollableLines = Math.max(
    0,
    transcriptLines.length - TRANSCRIPT_VIEWPORT_LINES,
  );
  const transcriptStart = Math.max(0, scrollableLines - state.scrollOffset);
  const transcriptEnd = Math.min(
    transcriptLines.length,
    transcriptStart + TRANSCRIPT_VIEWPORT_LINES,
  );
  const visible = transcriptLines.slice(transcriptStart, transcriptEnd);
  const hiddenToolLines = useMemo(() => {
    const hidden = new Set<string>();
    for (const line of visible) {
      if (line.role !== "tool" || line.kind === "role") continue;
      if (state.expandedTools.includes(line.messageId)) continue;
      if (line.id !== `${line.messageId}:0`) hidden.add(line.id);
    }
    return hidden;
  }, [visible, state.expandedTools]);
  const visibleMessagesMap = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    const neededIds = new Set(visible.map((l) => l.messageId));
    for (const message of state.messages) {
      if (neededIds.has(message.id)) {
        map.set(message.id, message);
      }
    }
    return map;
  }, [visible, state.messages]);
  const endpoint = state.endpoints[state.cursor];
  const session = runtime.header.sessionId;
  const filteredModels = endpoint
    ? filterModels(endpoint.models, modelPicker.filter)
    : [];
  const expandedToolId = state.expandedTools[state.expandedTools.length - 1];
  const expandedToolRecord = state.messages.find(
    (message) => message.id === expandedToolId,
  )?.toolId
    ? state.toolRecords[
        state.messages.find((message) => message.id === expandedToolId)!.toolId!
      ]
    : undefined;
  const toolDetails = expandedToolRecord
    ? toolDetailLines(expandedToolRecord)
    : [];
  const activeTabId = state.sessionTabs[state.activeSessionTab];
  const composerLine = (line: string, index: number): string =>
    index === state.composer.row
      ? `${line.slice(0, state.composer.col)}▌${line.slice(state.composer.col)}`
      : line;

  return (
    <Box flexDirection="column" height="100%" width="100%">
      <Box
        justifyContent="space-between"
        paddingX={1}
        borderStyle="double"
        borderColor={palette.border}
      >
        <Text bold color={palette.text}>
          CHAMP <Text color={palette.accent}>v{runtime.header.version}</Text>
        </Text>
        <Text color={palette.muted}>
          {state.selectedModel ?? runtime.header.model} ·{" "}
          {truncate(runtime.header.workspace, 36)}
          {session ? ` · ${session}` : ""}
        </Text>
      </Box>

      <Box paddingX={1}>
        {SCREENS.map((screen, index) => (
          <Box key={screen.id} marginRight={2}>
            <Text
              bold={state.screen === screen.id}
              color={
                state.screen === screen.id ? palette.accent : palette.muted
              }
            >
              {`${index + 1} ${screen.label}`}
            </Text>
          </Box>
        ))}
      </Box>

      {state.screen === "chat" && (
        <Box flexDirection="column" flexGrow={1}>
          <Panel title="Session" palette={palette}>
            {visible.length === 0 ? (
              <Text color={palette.muted}>
                Ask anything. Type /help for commands.
              </Text>
            ) : (
              visible.map((line) => {
                if (hiddenToolLines.has(line.id)) return null;
                const parent = visibleMessagesMap.get(line.messageId);
                const statusLine =
                  parent?.text.startsWith("✓") || parent?.text.startsWith("✗");
                if (statusLine && line.kind === "role") return null;
                if (statusLine && line.kind === "body") {
                  return (
                    <Text
                      key={line.id}
                      bold
                      color={
                        parent?.text.startsWith("✗")
                          ? palette.error
                          : palette.success
                      }
                    >
                      {line.text}
                    </Text>
                  );
                }
                if (line.kind === "role") {
                  const collapsed =
                    line.role === "tool" &&
                    !state.expandedTools.includes(line.messageId);
                  return (
                    <Text
                      key={line.id}
                      bold
                      color={roleColor(line.role, palette)}
                    >
                      {`${ROLE_GLYPHS[line.role]} ${line.text}${collapsed ? " · Ctrl-E to expand" : ""}`}
                    </Text>
                  );
                }
                const segments = line.segments ?? [{ text: line.text }];
                return (
                  <Text
                    key={line.id}
                    bold={line.kind === "heading"}
                    color={line.kind === "code" ? palette.muted : palette.text}
                  >
                    {segments.map((segment, index) => (
                      <Text
                        key={index}
                        bold={segment.bold}
                        italic={segment.italic}
                        underline={segment.link}
                        inverse={
                          segment.code || segment.highlight !== undefined
                        }
                        color={
                          segment.code
                            ? palette.highlight
                            : highlightColor(segment.highlight, palette)
                        }
                      >
                        {segment.text}
                      </Text>
                    ))}
                  </Text>
                );
              })
            )}
            <Text color={palette.muted}>
              {transcriptLines.length === 0
                ? "line 0 of 0"
                : `line ${transcriptStart + 1}-${transcriptEnd} of ${transcriptLines.length}${state.scrollOffset > 0 ? " (scrolled)" : ""}${state.unseen > 0 ? ` ↓ ${state.unseen} new` : ""}${state.truncated ? " (older turns trimmed)" : ""}`}
            </Text>
          </Panel>
          {expandedToolRecord && (
            <Panel title="Tool detail (Ctrl-E to close)" palette={palette}>
              {toolDetails.map((line) => (
                <Box key={line.label} flexDirection="column">
                  <Text bold color={palette.accent}>
                    {line.label}
                  </Text>
                  <Text color={palette.text}>{line.value || "(empty)"}</Text>
                </Box>
              ))}
            </Panel>
          )}
          {approval && (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={palette.warning}
              paddingX={1}
            >
              <Text bold color={palette.warning}>
                Approval Required
              </Text>
              <Text color={palette.text}>
                {truncate(approval.description, 200)}
              </Text>
              <Text bold color={palette.accent}>
                Press [y] Approve · [n/Esc] Deny
              </Text>
            </Box>
          )}
          <Box borderStyle="round" borderColor={palette.border} paddingX={1}>
            <Text color={state.busy ? palette.muted : palette.text}>
              <Text color={palette.accent}>{"› "}</Text>
              {state.busy
                ? "working…"
                : state.input === ""
                  ? "type a message"
                  : composerLine(state.composer.lines[0], 0)}
            </Text>
            {!state.busy &&
              state.composer.lines.slice(1).map((line, index) => (
                <Text key={index} color={palette.text}>
                  {composerLine(line, index + 1)}
                </Text>
              ))}
            {[...queuedPrompts.current.values()].some(
              (entry) => entry.status === "queued",
            ) && (
              <Text color={palette.warning}>
                {`queued: ${[...queuedPrompts.current.values()].filter((entry) => entry.status === "queued").length}`}
              </Text>
            )}
          </Box>
          {suggestions.length > 0 && (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor={palette.border}
              paddingX={1}
            >
              <Text bold color={palette.panelTitle}>
                Commands — ↑↓ select · Tab/Enter accept · Esc dismiss
              </Text>
              {suggestions.slice(0, 8).map((suggestion, index) => (
                <Text
                  key={suggestion.name}
                  color={
                    index === completionIndex ? palette.accent : palette.muted
                  }
                  bold={index === completionIndex}
                >
                  {`${index === completionIndex ? "▸" : " "} ${suggestion.name} — ${suggestion.description}`}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}

      {state.screen === "providers" && (
        <Panel title="Endpoints" palette={palette}>
          <Text color={palette.muted}>
            ↑↓ select · U pick model · R refresh · E edit · A add · T test · ?
            help
          </Text>
          {state.endpoints.length === 0 ? (
            <Text color={palette.warning}>
              No endpoints. Press A to add one.
            </Text>
          ) : (
            state.endpoints.map((item: EndpointSummary, index) => {
              const active = index === state.cursor;
              const selectedModel =
                item.id === state.selectedEndpointId
                  ? (state.selectedModel ?? item.models[0])
                  : item.models[0];
              return (
                <Box key={item.id} flexDirection="column" marginTop={1}>
                  <Text
                    bold={active}
                    color={active ? palette.accent : palette.text}
                  >
                    {`${active ? "▸" : " "} ${item.name} (${item.provider})`}
                  </Text>
                  <Text color={palette.muted}>
                    {`  ${truncate(item.baseUrl, 54)} · ${selectedModel ? modelLabel(selectedModel) : "no models"}`}
                  </Text>
                  {item.id === state.selectedEndpointId &&
                    state.selectedModel &&
                    !item.models.includes(state.selectedModel) && (
                      <Text
                        color={palette.warning}
                      >{`  ⚠ assigned model missing: ${state.selectedModel}`}</Text>
                    )}
                </Box>
              );
            })
          )}
          {modelPicker.open && endpoint && (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle="round"
              borderColor={palette.border}
              paddingX={1}
            >
              <Text bold color={palette.panelTitle}>
                {`Select model — ${endpoint.name}`}
              </Text>
              <Text color={palette.muted}>
                {`filter: ${modelPicker.filter || "(type to filter)"} · 1-9 quick pick · ↑↓ · Enter select · M manual · Esc clear`}
              </Text>
              {filteredModels.slice(0, 12).map((model, index) => {
                const selected = index === modelPicker.cursor;
                const active =
                  endpoint.id === state.selectedEndpointId &&
                  model === state.selectedModel;
                const detail = endpoint.modelDetails?.[model];
                return (
                  <Box key={model} flexDirection="column">
                    <Text
                      bold={selected}
                      color={selected ? palette.accent : palette.text}
                    >
                      {`${selected ? "▸" : " "} ${index + 1}. ${modelLabel(model)}${active ? " ✓" : ""}`}
                    </Text>
                    {detail && (
                      <Text color={palette.muted}>
                        {`    pinned=${detail.pinned ? "yes" : "no"} ctx=${detail.context ?? "unknown"} evidence=${detail.evidence ?? "none"} status=${detail.status ?? "unknown"}`}
                      </Text>
                    )}
                  </Box>
                );
              })}
              {filteredModels.length === 0 && (
                <Text color={palette.warning}>No matching models.</Text>
              )}
            </Box>
          )}
          {state.setup.open && (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle="round"
              borderColor={palette.border}
              paddingX={1}
            >
              <Text bold color={palette.panelTitle}>
                {editingEndpointId ? "Edit endpoint" : "New endpoint"}
              </Text>
              {SETUP_FIELDS.map((field) => (
                <Text
                  key={field}
                  color={field === setupField ? palette.accent : palette.muted}
                >
                  {`${field === setupField ? "▸" : " "} ${field}: ${state.setup[field]}`}
                </Text>
              ))}
              {state.setup.error && (
                <Text color={palette.error}>{state.setup.error}</Text>
              )}
              <Text color={palette.muted}>
                Tab next field · Enter next/save · Esc cancel
              </Text>
            </Box>
          )}
          {endpoint && (
            <Text
              color={palette.muted}
            >{`Selected: ${endpoint.name} · ${state.selectedModel ?? "no model"}`}</Text>
          )}
        </Panel>
      )}

      {state.screen === "config" && (
        <Panel title="Configuration" palette={palette}>
          <Text color={palette.muted}>
            S set value · I open editor · V validate · D doctor · E redacted
            export · Tab screen
          </Text>
          <Text
            color={palette.text}
          >{`workspace: ${runtime.header.workspace}`}</Text>
          <Text
            color={palette.text}
          >{`routing:   ${runtime.header.routingMode ?? "auto"}`}</Text>
          <Text
            color={palette.text}
          >{`model:     ${state.selectedModel ?? runtime.header.model}`}</Text>
          <Text
            color={palette.text}
          >{`registry:  ~/.champ/providers.json`}</Text>
          <Text color={palette.text}>{`yaml:      ~/.champ/config.yaml`}</Text>
          {configEntries.slice(0, 12).map((entry) => (
            <Text key={entry.key} color={palette.muted}>
              {`${entry.key} = ${entry.value || "(unset)"}`}
            </Text>
          ))}
          {configDraft.open && (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle="round"
              borderColor={palette.border}
              paddingX={1}
            >
              <Text bold color={palette.panelTitle}>
                Set config value
              </Text>
              {CONFIG_KEYS.slice(0, 12).map((entry) => (
                <Text
                  key={entry.key}
                  color={
                    entry.key === configDraft.key
                      ? palette.accent
                      : palette.muted
                  }
                  bold={entry.key === configDraft.key}
                >
                  {`${entry.key === configDraft.key ? "▸" : " "} ${entry.key} — ${entry.description}`}
                </Text>
              ))}
              <Text color={palette.text}>{`value: ${configDraft.value}`}</Text>
              <Text color={palette.muted}>
                Tab next key · Enter save · Esc cancel
              </Text>
            </Box>
          )}
          {state.diagnostics.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {state.diagnostics.slice(-20).map((line, index) => (
                <Text key={`${index}-${line}`} color={palette.muted}>
                  {truncate(line, 110)}
                </Text>
              ))}
            </Box>
          )}
          {doctorLines.length > 0 && (
            <Text
              color={palette.muted}
            >{`doctor: ${doctorLines.length} checks`}</Text>
          )}
        </Panel>
      )}

      {state.screen === "sessions" && (
        <Panel title="Sessions" palette={palette}>
          <Text color={palette.muted}>
            N rename · F fork · D delete · T tab · [/] switch tab · Enter resume
            · type to filter
          </Text>
          {state.sessionTabs.length > 0 && (
            <Text color={palette.muted}>
              {`tabs: ${state.sessionTabs
                .map(
                  (id, index) =>
                    `${index === state.activeSessionTab ? "[" : " "}${id}${index === state.activeSessionTab ? "]" : ""}`,
                )
                .join(" ")}`}
            </Text>
          )}
          {activeTabId && (
            <Text color={palette.accent}>
              {`lineage: ${sessionLineage(state.sessions, activeTabId)
                .map((item) => item.label)
                .join(" → ")}`}
            </Text>
          )}
          <Text color={palette.accent}>
            {state.sessionFilter
              ? `filter: ${state.sessionFilter}▌`
              : "filter: ▌"}
          </Text>
          {visibleSessions.length === 0 ? (
            <Text color={palette.warning}>
              {state.sessionFilter
                ? "No sessions match this filter."
                : "No stored sessions in this workspace."}
            </Text>
          ) : (
            visibleSessions.map((item: TuiSessionSummary, index) => (
              <Text
                key={item.id}
                bold={index === state.sessionCursor}
                color={
                  index === state.sessionCursor ? palette.accent : palette.text
                }
              >
                {`${index === state.sessionCursor ? "▸" : " "} ${item.id} — ${truncate(item.label, 44)} · ${item.updatedAt}${item.parentId ? ` · child of ${item.parentId}` : ""}${item.preview ? ` · ${truncate(item.preview, 40)}` : ""}`}
              </Text>
            ))
          )}
        </Panel>
      )}

      {state.screen === "review" && (
        <Panel title="Review" palette={palette}>
          <Text color={palette.muted}>
            ↑↓ select · A accept · R reject · Tab screen · Esc chat
          </Text>
          {state.reviews.length === 0 ? (
            <Text color={palette.warning}>No recorded edits to review.</Text>
          ) : (
            state.reviews.map((item: TuiReviewSummary, index) => (
              <Text
                key={item.id}
                bold={index === state.reviewCursor}
                color={
                  index === state.reviewCursor ? palette.accent : palette.text
                }
              >
                {`${index === state.reviewCursor ? "▸" : " "} ${item.id} [${item.status}] ${item.files} file(s) — ${truncate(item.summary, 54)}`}
              </Text>
            ))
          )}
        </Panel>
      )}

      {state.screen === "tasks" && (
        <Panel title="Tasks" palette={palette}>
          <Text color={palette.muted}>
            ↑↓ select · A start · X cancel · background tasks stay queued per
            session
          </Text>
          {state.tasks.length === 0 ? (
            <Text color={palette.warning}>No tasks yet.</Text>
          ) : (
            state.tasks.map((task, index) => (
              <Text
                key={task.id}
                bold={index === taskCursor}
                color={index === taskCursor ? palette.accent : palette.text}
              >
                {`${index === taskCursor ? "▸" : " "} ${task.id} [${task.status}] ${task.sessionId}${task.background ? " · background" : ""} — ${task.label}`}
              </Text>
            ))
          )}
          {Object.entries(state.sessionExecutions).map(([id, status]) => (
            <Text key={id} color={palette.muted}>
              {`${id}: ${status}`}
            </Text>
          ))}
        </Panel>
      )}

      {state.screen === "plan" && (
        <Panel title="Execution plan" palette={palette}>
          <Text color={palette.muted}>
            Live tool steps · Enter advance · 1-9 mark blocked
          </Text>
          <Text color={palette.accent}>
            {`${planProgress(state.plan).done}/${planProgress(state.plan).total} · ${planProgress(state.plan).percent}%`}
          </Text>
          {state.plan.length === 0 ? (
            <Text color={palette.warning}>No plan yet — run a prompt.</Text>
          ) : (
            state.plan.map((step, index) => (
              <Text key={step.id} color={palette.text}>
                {`${index + 1}. [${step.status}] ${step.text}`}
              </Text>
            ))
          )}
        </Panel>
      )}

      {state.screen === "context" && (
        <Panel title="Context" palette={palette}>
          <Text color={palette.muted}>
            C checkpoint · K compact · ↑↓ snapshot · Enter rewind · Z undo · Y
            redo
          </Text>
          <Text bold color={palette.accent}>
            {`${contextBudget(state.context).bar} ${contextBudget(state.context).percent}%`}
          </Text>
          <Text color={palette.text}>
            {`${contextBudget(state.context).used}/${state.context.limit} tokens · ${contextBudget(state.context).remaining} remaining · ${state.context.messages} messages · ${state.context.model}`}
          </Text>
          <Text bold color={palette.panelTitle}>
            Compaction history
          </Text>
          {state.context.compactions.length === 0 ? (
            <Text color={palette.muted}>No checkpoints yet.</Text>
          ) : (
            state.context.compactions.map((entry, index) => (
              <Text key={`${entry.at}-${index}`} color={palette.text}>
                {`${entry.label} · ${entry.at} · ${entry.elided} elided`}
              </Text>
            ))
          )}
          <Text bold color={palette.panelTitle}>
            Recovery snapshots
          </Text>
          {recoverySnapshots.length === 0 ? (
            <Text color={palette.muted}>No snapshots yet.</Text>
          ) : (
            recoverySnapshots.map((snapshot, index) => (
              <Text
                key={snapshot.id}
                bold={index === taskCursor}
                color={index === taskCursor ? palette.accent : palette.text}
              >
                {`${index === taskCursor ? "▸" : " "} ${snapshot.label} — ${snapshot.at}${canUndo(state.recovery) && state.recovery.present.id === snapshot.id ? " (present)" : ""}`}
              </Text>
            ))
          )}
          <Text color={palette.muted}>
            {`undo=${canUndo(state.recovery)} redo=${canRedo(state.recovery)}`}
          </Text>
        </Panel>
      )}

      {state.screen === "usage" && (
        <Panel title="Usage & cost" palette={palette}>
          <Text color={palette.muted}>↑↓ select a turn</Text>
          <Text color={palette.accent}>
            {`${usageTotals(state.usage).turns} turns · in=${usageTotals(state.usage).inputTokens} out=${usageTotals(state.usage).outputTokens} cache=${usageTotals(state.usage).cacheReadTokens}/${usageTotals(state.usage).cacheWriteTokens} · $${usageTotals(state.usage).costUsd.toFixed(4)} · ${usageTotals(state.usage).latencyMs}ms`}
          </Text>
          {state.usage.length === 0 ? (
            <Text color={palette.warning}>No usage recorded yet.</Text>
          ) : (
            state.usage.map((record, index) => (
              <Text
                key={`${record.at}-${index}`}
                bold={index === taskCursor}
                color={index === taskCursor ? palette.accent : palette.text}
              >
                {`${index === taskCursor ? "▸" : " "} ${record.at} — ${usageLine(record)}`}
              </Text>
            ))
          )}
        </Panel>
      )}

      {state.screen === "mcp" && (
        <Panel title="MCP servers" palette={palette}>
          <Text color={palette.muted}>↑↓ select · R restart selected</Text>
          {state.mcpServers.length === 0 ? (
            <Text color={palette.warning}>No MCP servers configured.</Text>
          ) : (
            state.mcpServers.map((server, index) => (
              <Text
                key={server.name}
                bold={index === mcpCursor}
                color={
                  server.health === "healthy"
                    ? palette.success
                    : server.health === "down"
                      ? palette.error
                      : palette.warning
                }
              >
                {`${index === mcpCursor ? "▸" : " "} ${mcpSummary(server)}${index === mcpCursor ? "  ← R to restart" : ""}`}
              </Text>
            ))
          )}
        </Panel>
      )}

      {state.screen === "help" && (
        <Panel title="Help" palette={palette}>
          <Text bold color={palette.panelTitle}>
            Essentials
          </Text>
          <Text color={palette.text}>
            Ctrl-P — command palette · Ctrl-O — edit prompt in $EDITOR
          </Text>
          <Text color={palette.text}>
            Tab — cycle screens · Esc — return to chat
          </Text>
          <Text color={palette.text}>
            Enter — submit · Ctrl-Enter — newline · Ctrl-C — abort or exit
          </Text>
          <Text color={palette.text}>
            Providers: U pick model · E edit · A add · T test · R refresh · P
            pool · O scope
          </Text>
          <Text color={palette.text}>
            Sessions: type to filter, Enter resume · Review: A accept, R reject
          </Text>
          {advancedHelp ? (
            <>
              <Text bold color={palette.panelTitle}>
                Advanced
              </Text>
              <Text color={palette.muted}>
                PgUp/PgDn — scroll transcript · Home/End — oldest/newest
              </Text>
              <Text color={palette.muted}>
                Up/Down — transcript scroll or prompt history
              </Text>
              <Text color={palette.muted}>
                Ctrl-E — expand the last tool call
              </Text>
              <Text color={palette.muted}>
                Config: S set value · I editor · V validate · D doctor · E
                export
              </Text>
              {Object.entries(CHAT_COMMAND_HELP).map(([name, desc]) => (
                <Text key={name} color={palette.muted}>
                  {name} — {desc}
                </Text>
              ))}
            </>
          ) : (
            <Text color={palette.muted}>
              ? — show scrollback, config and slash commands
            </Text>
          )}
        </Panel>
      )}

      {state.paletteOpen && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={palette.accent}
          paddingX={1}
        >
          <Text bold color={palette.panelTitle}>
            {`Command palette — ${state.paletteQuery || "type to search"}▌`}
          </Text>
          {visiblePaletteActions.slice(0, 10).map((action, index) => (
            <Text
              key={action.id}
              bold={index === state.paletteCursor}
              color={
                index === state.paletteCursor ? palette.accent : palette.muted
              }
            >
              {`${index === state.paletteCursor ? "▸" : " "} ${action.label} — ${action.description}`}
            </Text>
          ))}
          {visiblePaletteActions.length === 0 && (
            <Text color={palette.warning}>No matching actions.</Text>
          )}
        </Box>
      )}
      {poolPrompt && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={palette.accent}
          paddingX={1}
        >
          <Text bold color={palette.panelTitle}>
            {poolPrompt.kind === "create"
              ? "Create endpoint pool"
              : "Select routing pool"}
          </Text>
          <Text color={palette.muted}>
            {poolPrompt.kind === "create"
              ? "name:endpoint-id,endpoint-id"
              : "pool id or name"}
          </Text>
          <Text color={palette.text}>{`${poolPrompt.value}▌`}</Text>
          <Text color={palette.muted}>Enter confirm · Esc cancel</Text>
        </Box>
      )}
      {sessionPrompt && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={palette.accent}
          paddingX={1}
        >
          <Text bold color={palette.panelTitle}>
            {sessionPrompt.kind === "rename"
              ? "Rename session"
              : "Fork session"}
          </Text>
          <Text color={palette.text}>{`${sessionPrompt.value}▌`}</Text>
          <Text color={palette.muted}>Enter confirm · Esc cancel</Text>
        </Box>
      )}

      <Box justifyContent="space-between" paddingX={1}>
        <Text color={palette.muted}>{truncate(state.status, 60)}</Text>
        <Text color={palette.muted}>
          {state.selectedModel ?? runtime.header.model} ·{" "}
          {runtime.header.routingMode ?? "auto"} · {session ?? "no session"}
        </Text>
        <Text color={palette.accent}>{FOOTER_HINTS[state.screen]}</Text>
      </Box>
    </Box>
  );
}

export async function runTui(runtime: TuiRuntime): Promise<void> {
  // Use alternate screen buffer (\x1b[?1049h) so terminal scrollback is preserved
  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l");
  const instance = render(<App runtime={runtime} />);
  try {
    await instance.waitUntilExit();
  } finally {
    instance.clear();
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }
}

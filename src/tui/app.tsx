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
  useState,
  type ReactNode,
} from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import {
  initialTuiState,
  tuiReducer,
  TRANSCRIPT_PAGE_SIZE,
  type EndpointSummary,
  type TuiReviewSummary,
  type TuiScreen,
  type TuiSessionSummary,
} from "./state";
import type { TuiConfigEntry, TuiRuntime } from "./runtime";
import { dedupeEndpointSummaries, resolveTuiSelection } from "./endpoints";
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
];

/** Context-sensitive hints replace a flat key dump in the footer. */
const FOOTER_HINTS: Record<TuiScreen, string> = {
  chat: "? help · Tab screens · Ctrl-C exit",
  providers: "↑↓ select · U models · ? help",
  config: "S set · I editor · ? help",
  help: "? advanced · Esc chat",
  sessions: "Enter resume · ? help",
  review: "A accept · R reject · ? help",
};

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
  const palette = PALETTES[theme];

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
    if (state.screen === "sessions" && runtime.listSessions) {
      void runtime.listSessions().then((sessions) => {
        if (alive) dispatch({ type: "sessions/set", sessions });
      });
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
    return () => {
      alive = false;
    };
  }, [runtime, state.screen]);

  const suggestions = useMemo(
    () =>
      /^\/[^\s]*$/.test(state.input) ? commandSuggestions(state.input) : [],
    [state.input],
  );

  const submit = useCallback(async () => {
    const text = state.input.trim();
    if (!text || state.busy) return;

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
      const canonical = canonicalChatCommand(text);
      const commandText = canonical
        ? [canonical, ...text.trim().split(/\s+/).slice(1)].join(" ")
        : text;
      const output = await runtime.command(commandText);
      if (output !== null) {
        dispatch({
          type: "message/add",
          role: "system",
          text: output,
        });
        return;
      }
    }

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
          onTool: (name, args) =>
            dispatch({
              type: "message/add",
              role: "tool",
              text: `${name} ${truncate(args, 120)}`,
            }),
          onError: (message) =>
            dispatch({ type: "message/add", role: "error", text: message }),
          onDone: (summary) =>
            dispatch({
              type: "status/set",
              text: `tools=${summary.tools} tokens ${summary.inputTokens}/${summary.outputTokens}`,
            }),
        },
        (description) =>
          new Promise<boolean>((resolve) => {
            setApproval({ description, resolve });
          }),
      );
      dispatch({
        type: "status/set",
        text: result.aborted
          ? "Aborted"
          : result.error
            ? `Error: ${truncate(result.error, 90)}`
            : "Ready",
      });
    } catch (err) {
      dispatch({
        type: "message/add",
        role: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      dispatch({ type: "turn/stop" });
    }
  }, [exit, runtime, state.busy, state.input]);

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
        const message = await runtime.resumeSession(id);
        dispatch({ type: "status/set", text: message });
        if (runtime.listSessions) {
          dispatch({
            type: "sessions/set",
            sessions: await runtime.listSessions(),
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
      if (input.length === 1 && !key.ctrl && !key.meta) {
        dispatch({
          type: "setup/change",
          field: setupField,
          value: state.setup[setupField] + input,
        });
      }
      return;
    }

    if (input === "?" && !state.busy) {
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
        dispatch({ type: "transcript/scroll", delta: -5 });
        return;
      }
      if (key.pageDown) {
        dispatch({ type: "transcript/scroll", delta: 5 });
        return;
      }
      if (state.busy) return;
      if (key.return) {
        void submit();
      } else if (key.backspace || key.delete) {
        dispatch({ type: "input/set", value: state.input.slice(0, -1) });
      } else if (key.upArrow || key.downArrow) {
        if (state.input === "") {
          dispatch({
            type: "transcript/scroll",
            delta: key.upArrow ? -1 : 1,
          });
        } else {
          dispatch({ type: key.upArrow ? "history/prev" : "history/next" });
        }
      } else if (input.length === 1 && !key.ctrl && !key.meta) {
        dispatch({ type: "input/set", value: state.input + input });
        setCompletionIndex(0);
      }
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
        if (input.length === 1 && !key.ctrl && !key.meta) {
          if (/^[1-9]$/.test(input) && !modelPicker.filter) {
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
          setModelPicker((picker) => ({
            ...picker,
            filter: picker.filter + input,
            cursor: 0,
          }));
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
        if (input.length === 1 && !key.ctrl && !key.meta) {
          setConfigDraft({ ...configDraft, value: configDraft.value + input });
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
      if (key.upArrow) dispatch({ type: "sessions/cursor", delta: -1 });
      else if (key.downArrow) dispatch({ type: "sessions/cursor", delta: 1 });
      else if (key.return) {
        const selected = state.sessions[state.sessionCursor];
        if (selected) void resumeSession(selected.id);
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

  const transcriptStart = Math.max(
    0,
    state.messages.length - TRANSCRIPT_PAGE_SIZE - state.scrollOffset,
  );
  const transcriptEnd = Math.min(
    state.messages.length,
    transcriptStart + TRANSCRIPT_PAGE_SIZE,
  );
  const visible = state.messages.slice(transcriptStart, transcriptEnd);
  const endpoint = state.endpoints[state.cursor];
  const session = runtime.header.sessionId;
  const filteredModels = endpoint
    ? filterModels(endpoint.models, modelPicker.filter)
    : [];

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
              visible.map((message) => (
                <Box key={message.id} flexDirection="column" marginBottom={1}>
                  <Text
                    bold
                    color={
                      message.role === "user"
                        ? palette.accent
                        : message.role === "error"
                          ? palette.error
                          : message.role === "tool"
                            ? palette.warning
                            : palette.success
                    }
                  >
                    {message.role.toUpperCase()}
                  </Text>
                  <Text color={palette.text}>{message.text}</Text>
                </Box>
              ))
            )}
            <Text color={palette.muted}>
              {state.messages.length === 0
                ? "line 0 of 0"
                : `line ${transcriptStart + 1}-${transcriptEnd} of ${state.messages.length}${state.scrollOffset > 0 ? " (scrolled)" : ""}`}
            </Text>
          </Panel>
          {approval && (
            <Box borderStyle="round" borderColor={palette.warning} paddingX={1}>
              <Text color={palette.warning}>
                {truncate(approval.description, 100)} [y/N]
              </Text>
            </Box>
          )}
          <Box borderStyle="round" borderColor={palette.border} paddingX={1}>
            <Text color={palette.accent}>{"› "}</Text>
            <Text color={state.busy ? palette.muted : palette.text}>
              {state.busy ? "working…" : state.input || "type a message"}
            </Text>
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
            ↑↓ select · U pick model · E edit · A add · T test · ? help
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
                return (
                  <Text
                    key={model}
                    bold={selected}
                    color={selected ? palette.accent : palette.text}
                  >
                    {`${selected ? "▸" : " "} ${index + 1}. ${modelLabel(model)}${active ? " ✓" : ""}`}
                  </Text>
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
            ↑↓ select · Enter resume · Tab screen · Esc chat
          </Text>
          {state.sessions.length === 0 ? (
            <Text color={palette.warning}>
              No stored sessions in this workspace.
            </Text>
          ) : (
            state.sessions.map((item: TuiSessionSummary, index) => (
              <Text
                key={item.id}
                bold={index === state.sessionCursor}
                color={
                  index === state.sessionCursor ? palette.accent : palette.text
                }
              >
                {`${index === state.sessionCursor ? "▸" : " "} ${item.id} — ${truncate(item.label, 54)} · ${item.updatedAt}`}
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

      {state.screen === "help" && (
        <Panel title="Help" palette={palette}>
          <Text bold color={palette.panelTitle}>
            Essentials
          </Text>
          <Text color={palette.text}>
            Tab — cycle screens · Esc — return to chat
          </Text>
          <Text color={palette.text}>
            Ctrl-C — abort turn or exit · ? — toggle advanced
          </Text>
          <Text color={palette.text}>
            Providers: U pick model · E edit · A add · T test
          </Text>
          <Text color={palette.text}>
            Sessions: Enter resume · Review: A accept, R reject
          </Text>
          {advancedHelp ? (
            <>
              <Text bold color={palette.panelTitle}>
                Advanced
              </Text>
              <Text color={palette.muted}>PgUp/PgDn — scroll transcript</Text>
              <Text color={palette.muted}>
                Up/Down — transcript scroll or prompt history
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

      <Box justifyContent="space-between" paddingX={1}>
        <Text color={palette.muted}>{truncate(state.status, 90)}</Text>
        <Text color={palette.accent}>{FOOTER_HINTS[state.screen]}</Text>
      </Box>
    </Box>
  );
}

export async function runTui(runtime: TuiRuntime): Promise<void> {
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");
  const instance = render(<App runtime={runtime} />);
  try {
    await instance.waitUntilExit();
  } finally {
    instance.clear();
    process.stdout.write("\x1b[?25h");
  }
}

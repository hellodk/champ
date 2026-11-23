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
  useReducer,
  useState,
  type ReactNode,
} from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import {
  initialTuiState,
  tuiReducer,
  type EndpointSummary,
  type TuiScreen,
} from "./state";
import type { TuiRuntime } from "./runtime";

const SCREENS: Array<{ id: TuiScreen; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "providers", label: "Providers" },
  { id: "config", label: "Config" },
  { id: "help", label: "Help" },
];

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
}: {
  title: string;
  children: ReactNode;
  flexGrow?: number;
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="#3B4261"
      paddingX={1}
      flexGrow={flexGrow}
      minHeight={6}
    >
      <Text bold color="#89DDFF">
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function App({ runtime }: { runtime: TuiRuntime }) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(tuiReducer, undefined, () => ({
    ...initialTuiState({
      workspace: runtime.header.workspace,
      model: runtime.header.model,
      endpoints: runtime.initialEndpoints,
      selectedEndpointId: runtime.initialEndpoints[0]?.id,
      selectedModel: runtime.header.model,
      status:
        runtime.initialEndpoints.length === 0
          ? "No endpoints configured — press A to add one"
          : "Ready",
    }),
    screen: runtime.initialScreen ?? "chat",
  }));
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [setupField, setSetupField] = useState<SetupField>("name");
  const [doctorLines, setDoctorLines] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void runtime.refreshEndpoints().then((endpoints) => {
      if (alive) dispatch({ type: "endpoints/set", endpoints });
    });
    return () => {
      alive = false;
    };
  }, [runtime]);

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
    if (text === "/model" || text === "/providers") {
      dispatch({ type: "screen/set", screen: "providers" });
      return;
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

  const addEndpoint = useCallback(async () => {
    if (state.setup.saving) return;
    dispatch({ type: "setup/submit" });
    if (!state.setup.name.trim()) return;

    try {
      const message = await runtime.addEndpoint({
        name: state.setup.name,
        provider: state.setup.provider,
        baseUrl: state.setup.baseUrl || undefined,
        credentialId: state.setup.credentialId || undefined,
        apiKey: state.setup.apiKey || undefined,
        model: state.setup.model || undefined,
      });
      const endpoints = await runtime.refreshEndpoints();
      dispatch({ type: "endpoints/set", endpoints });
      dispatch({ type: "setup/result", status: message });
      setSetupField("name");
    } catch (err) {
      dispatch({
        type: "setup/result",
        status: err instanceof Error ? err.message : String(err),
        error: true,
      });
    }
  }, [runtime, state.setup]);

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
      if (state.setup.open) {
        dispatch({ type: "setup/cancel" });
        return;
      }
      dispatch({ type: "screen/set", screen: "chat" });
      return;
    }

    const setupOpen = state.screen === "providers" && state.setup.open;
    if (setupOpen) {
      const index = SETUP_FIELDS.indexOf(setupField);
      if (key.tab) {
        setSetupField(SETUP_FIELDS[(index + 1) % SETUP_FIELDS.length]);
        return;
      }
      if (key.return) {
        if (setupField === "model") void addEndpoint();
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

    if (key.tab) {
      dispatch({ type: "screen/next" });
      return;
    }

    if (state.screen === "chat") {
      if (state.busy) return;
      if (key.return) {
        void submit();
      } else if (key.backspace || key.delete) {
        dispatch({ type: "input/set", value: state.input.slice(0, -1) });
      } else if (input.length === 1 && !key.ctrl && !key.meta) {
        dispatch({ type: "input/set", value: state.input + input });
      }
      return;
    }

    if (state.screen === "providers") {
      if (key.upArrow) dispatch({ type: "endpoints/cursor", delta: -1 });
      else if (key.downArrow) dispatch({ type: "endpoints/cursor", delta: 1 });
      else if (input.toLowerCase() === "a") dispatch({ type: "setup/open" });
      else if (input.toLowerCase() === "u") {
        const endpoint = state.endpoints[state.cursor];
        const model = endpoint?.models[0];
        if (endpoint && model) {
          void runtime
            .selectModel(endpoint.id, model)
            .then((message) => dispatch({ type: "status/set", text: message }))
            .catch((err: unknown) =>
              dispatch({
                type: "status/set",
                text: err instanceof Error ? err.message : String(err),
              }),
            );
        }
      } else if (input.toLowerCase() === "t") {
        const endpoint = state.endpoints[state.cursor];
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
  });

  const visible = state.messages.slice(-18);
  const endpoint = state.endpoints[state.cursor];
  const session = runtime.header.sessionId;

  return (
    <Box flexDirection="column" height="100%" width="100%">
      <Box
        justifyContent="space-between"
        paddingX={1}
        borderStyle="double"
        borderColor="#444CE7"
      >
        <Text bold color="#FFFFFF">
          CHAMP <Text color="#444CE7">v{runtime.header.version}</Text>
        </Text>
        <Text color="#A6ACCD">
          {runtime.header.model} · {truncate(runtime.header.workspace, 36)}
          {session ? ` · ${session}` : ""}
        </Text>
      </Box>

      <Box paddingX={1}>
        {SCREENS.map((screen, index) => (
          <Box key={screen.id} marginRight={2}>
            <Text
              bold={state.screen === screen.id}
              color={state.screen === screen.id ? "#444CE7" : "#6B7280"}
            >
              {`${index + 1} ${screen.label}`}
            </Text>
          </Box>
        ))}
      </Box>

      {state.screen === "chat" && (
        <Box flexDirection="column" flexGrow={1}>
          <Panel title="Session">
            {visible.length === 0 ? (
              <Text color="#6B7280">
                Ask anything. Type /help for commands.
              </Text>
            ) : (
              visible.map((message) => (
                <Box key={message.id} flexDirection="column" marginBottom={1}>
                  <Text
                    bold
                    color={
                      message.role === "user"
                        ? "#444CE7"
                        : message.role === "error"
                          ? "#DC2626"
                          : message.role === "tool"
                            ? "#D97706"
                            : "#16A34A"
                    }
                  >
                    {message.role.toUpperCase()}
                  </Text>
                  <Text color="#D1D5DB">{message.text}</Text>
                </Box>
              ))
            )}
          </Panel>
          {approval && (
            <Box borderStyle="round" borderColor="#D97706" paddingX={1}>
              <Text color="#FCD34D">
                {truncate(approval.description, 100)} [y/N]
              </Text>
            </Box>
          )}
          <Box borderStyle="round" borderColor="#444CE7" paddingX={1}>
            <Text color="#444CE7">{"› "}</Text>
            <Text color={state.busy ? "#6B7280" : "#FFFFFF"}>
              {state.busy ? "working…" : state.input || "type a message"}
            </Text>
          </Box>
        </Box>
      )}

      {state.screen === "providers" && (
        <Panel title="Endpoints">
          <Text color="#6B7280">
            ↑↓ select · U use model · T test · A add endpoint · Tab screen · Esc
            chat
          </Text>
          {state.endpoints.length === 0 ? (
            <Text color="#D97706">No endpoints. Press A to add one.</Text>
          ) : (
            state.endpoints.map((item: EndpointSummary, index) => (
              <Box key={item.id} flexDirection="column" marginTop={1}>
                <Text
                  bold={index === state.cursor}
                  color={index === state.cursor ? "#444CE7" : "#D1D5DB"}
                >
                  {`${index === state.cursor ? "▸" : " "} ${item.name} (${item.provider})`}
                </Text>
                <Text color="#6B7280">
                  {`  ${item.id} · ${truncate(item.baseUrl, 54)} · ${item.models[0] ?? "no models"}`}
                </Text>
              </Box>
            ))
          )}
          {state.setup.open && (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle="round"
              borderColor="#444CE7"
              paddingX={1}
            >
              <Text bold color="#89DDFF">
                New endpoint
              </Text>
              {SETUP_FIELDS.map((field) => (
                <Text
                  key={field}
                  color={field === setupField ? "#FFFFFF" : "#6B7280"}
                >
                  {`${field === setupField ? "▸" : " "} ${field}: ${state.setup[field]}`}
                </Text>
              ))}
              {state.setup.error && (
                <Text color="#DC2626">{state.setup.error}</Text>
              )}
              <Text color="#6B7280">
                Tab next field · Enter next/save · Esc cancel
              </Text>
            </Box>
          )}
          {endpoint && (
            <Text color="#6B7280">{`Selected: ${endpoint.name}`}</Text>
          )}
        </Panel>
      )}

      {state.screen === "config" && (
        <Panel title="Configuration">
          <Text color="#6B7280">
            V validate · D doctor · E redacted export · Tab screen
          </Text>
          <Text color="#D1D5DB">{`workspace: ${runtime.header.workspace}`}</Text>
          <Text color="#D1D5DB">{`routing:   ${runtime.header.routingMode ?? "auto"}`}</Text>
          <Text color="#D1D5DB">{`model:     ${runtime.header.model}`}</Text>
          <Text color="#D1D5DB">{`registry:  ~/.champ/providers.json`}</Text>
          <Text color="#D1D5DB">{`yaml:      ~/.champ/config.yaml (legacy)`}</Text>
          {state.diagnostics.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {state.diagnostics.slice(-20).map((line, index) => (
                <Text key={`${index}-${line}`} color="#A6ACCD">
                  {truncate(line, 110)}
                </Text>
              ))}
            </Box>
          )}
          {doctorLines.length > 0 && (
            <Text color="#6B7280">{`doctor: ${doctorLines.length} checks`}</Text>
          )}
        </Panel>
      )}

      {state.screen === "help" && (
        <Panel title="Help">
          <Text color="#D1D5DB">Tab — cycle screens</Text>
          <Text color="#D1D5DB">Esc — return to chat</Text>
          <Text color="#D1D5DB">Ctrl-C — abort turn or exit</Text>
          <Text color="#D1D5DB">/clear — clear transcript</Text>
          <Text color="#D1D5DB">/model — open provider selection</Text>
          <Text color="#D1D5DB">/exit — leave Champ</Text>
        </Panel>
      )}

      <Box justifyContent="space-between" paddingX={1}>
        <Text color="#6B7280">{truncate(state.status, 90)}</Text>
        <Text color="#444CE7">Tab screens · Ctrl-C exit</Text>
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

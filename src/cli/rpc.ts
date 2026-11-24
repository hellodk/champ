/**
 * Subprocess RPC transport for Champ.
 *
 * One JSON request per stdin line, one JSON line out per response or event.
 * The wire format has no knowledge of controller, provider or tool classes —
 * every value is a plain JSON object. The runtime behind `execute` is the same
 * `executeTurn` used by the CLI, REPL and TUI.
 */
import { createInterface } from "readline";
import type { Readable } from "stream";
import type { ToolCall, TokenUsage } from "../providers/types";
import type { ToolCompletionEvent, TurnOutcome } from "./turn-runtime";

export const RPC_PROTOCOL_VERSION = 1 as const;

export interface RpcRequest {
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id?: string | number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface RpcNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface RpcTurnEvents {
  onText?: (chunk: string) => void;
  onTool?: (call: ToolCall) => void;
  onToolResult?: (result: ToolCompletionEvent) => void;
  onError?: (message: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}

export type RpcApproval = (description: string) => Promise<boolean>;

export interface RpcServerDeps {
  /** Execute one turn on the shared runtime. */
  execute: (
    text: string,
    events: RpcTurnEvents,
    requestApproval: RpcApproval,
  ) => Promise<TurnOutcome>;
  abort: () => boolean;
  getState: () => Record<string, unknown>;
  getSession: () => Promise<Record<string, unknown>>;
  setModel: (params: {
    provider?: string;
    model: string;
  }) => Promise<Record<string, unknown>>;
  setMode: (mode: string) => Record<string, unknown>;
  listTools: () => Array<{ name: string; description?: string }>;
  input?: Readable;
  write?: (line: string) => void;
}

interface PendingApproval {
  token: string;
  description: string;
  resolve: (approved: boolean) => void;
}

const MODES = ["agent", "ask", "manual", "plan", "composer"] as const;

/** Run the RPC server until stdin closes. Returns a process exit code. */
export async function runRpcServer(deps: RpcServerDeps): Promise<number> {
  const write = deps.write ?? ((line: string) => process.stdout.write(line));
  const input = deps.input ?? process.stdin;
  let pending: PendingApproval | null = null;
  let approvalSeq = 0;
  let busy = false;
  let active: Promise<void> | null = null;
  // Configuration changes and the state query must observe the same order as
  // the request stream. Control calls (abort/approve_tool) bypass this queue so
  // they can act on an in-flight prompt.
  let configTail: Promise<void> = Promise.resolve();
  const serializeConfig = (work: () => Promise<void>): Promise<void> => {
    const next = configTail.then(work, work);
    configTail = next.catch(() => {});
    return next;
  };

  const notify = (method: string, params: Record<string, unknown>): void => {
    write(`${JSON.stringify({ method, params } satisfies RpcNotification)}\n`);
  };

  const reply = (
    id: string | number | undefined,
    result: Record<string, unknown>,
  ): void => {
    write(
      `${JSON.stringify({ id, ok: true, result } satisfies RpcResponse)}\n`,
    );
  };

  const replyError = (
    id: string | number | undefined,
    code: string,
    message: string,
  ): void => {
    write(
      `${JSON.stringify({ id, ok: false, error: { code, message } } satisfies RpcResponse)}\n`,
    );
  };

  const resolvePending = (approved: boolean): PendingApproval | null => {
    const current = pending;
    if (!current) return null;
    pending = null;
    current.resolve(approved);
    return current;
  };

  const handlePrompt = async (
    id: string | number | undefined,
    params: Record<string, unknown>,
  ): Promise<void> => {
    if (typeof params.text !== "string" || !params.text.trim()) {
      replyError(id, "invalid_params", "prompt requires a non-empty text");
      return;
    }
    if (busy) {
      replyError(id, "busy", "a prompt is already running");
      return;
    }
    busy = true;
    try {
      const outcome = await deps.execute(
        params.text,
        {
          onText: (chunk) => notify("message.delta", { text: chunk }),
          onTool: (call) =>
            notify("tool.started", {
              id: call.id,
              name: call.name,
              arguments: call.arguments ?? {},
            }),
          onToolResult: (result) =>
            notify(result.success ? "tool.completed" : "tool.failed", {
              id: result.id ?? result.name ?? "",
              name: result.name ?? "",
              output: result.output,
            }),
          onError: (message) => notify("error", { message }),
          onUsage: (usage) =>
            notify("usage", {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
            }),
        },
        (description) =>
          new Promise<boolean>((resolveApproval) => {
            const token = `approval-${++approvalSeq}`;
            pending = {
              token,
              description,
              resolve: resolveApproval,
            };
            notify("approval.required", { token, description });
          }),
      );
      reply(id, {
        text: outcome.text,
        status: outcome.status,
        aborted: outcome.aborted,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    } catch (err) {
      replyError(
        id,
        "internal_error",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      busy = false;
      resolvePending(false);
    }
  };

  const dispatch = (
    id: string | number | undefined,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> => {
    switch (method) {
      case "prompt":
        return handlePrompt(id, params);
      case "abort": {
        const aborted = deps.abort();
        resolvePending(false);
        reply(id, { aborted });
        return Promise.resolve();
      }
      case "get_state":
        return serializeConfig(async () => {
          reply(id, {
            aborting: false,
            ...deps.getState(),
            busy,
            protocol: RPC_PROTOCOL_VERSION,
          });
        });
      case "get_session":
        return deps
          .getSession()
          .then((session) => reply(id, session))
          .catch((err: unknown) =>
            replyError(
              id,
              "internal_error",
              err instanceof Error ? err.message : String(err),
            ),
          );
      case "set_model": {
        if (typeof params.model !== "string" || !params.model.trim()) {
          replyError(id, "invalid_params", "set_model requires a model");
          return Promise.resolve();
        }
        if (
          params.provider !== undefined &&
          typeof params.provider !== "string"
        ) {
          replyError(id, "invalid_params", "provider must be a string");
          return Promise.resolve();
        }
        if (busy) {
          replyError(
            id,
            "busy",
            "cannot change the model while a prompt is running",
          );
          return Promise.resolve();
        }
        const model = params.model;
        const providerName = params.provider as string | undefined;
        return serializeConfig(async () => {
          try {
            const result = await deps.setModel({
              model,
              provider: providerName,
            });
            reply(id, result);
          } catch (err) {
            replyError(
              id,
              "internal_error",
              err instanceof Error ? err.message : String(err),
            );
          }
        });
      }
      case "set_mode": {
        if (
          typeof params.mode !== "string" ||
          !MODES.includes(params.mode as never)
        ) {
          replyError(
            id,
            "invalid_params",
            `mode must be one of ${MODES.join(", ")}`,
          );
          return Promise.resolve();
        }
        if (busy) {
          replyError(
            id,
            "busy",
            "cannot change the mode while a prompt is running",
          );
          return Promise.resolve();
        }
        const mode = params.mode;
        return serializeConfig(async () => {
          reply(id, deps.setMode(mode));
        });
      }
      case "approve_tool": {
        if (typeof params.approved !== "boolean") {
          replyError(
            id,
            "invalid_params",
            "approve_tool requires approved: boolean",
          );
          return Promise.resolve();
        }
        const token =
          typeof params.token === "string" ? params.token : undefined;
        const current =
          token && pending?.token === token ? pending : token ? null : pending;
        if (!current) {
          replyError(id, "no_pending_approval", "no approval is pending");
          return Promise.resolve();
        }
        if (current !== pending) {
          replyError(
            id,
            "no_pending_approval",
            "approval token does not match",
          );
          return Promise.resolve();
        }
        resolvePending(params.approved);
        reply(id, { approved: params.approved });
        return Promise.resolve();
      }
      case "list_tools":
        reply(id, { tools: deps.listTools() });
        return Promise.resolve();
      default:
        replyError(id, "unknown_method", `unknown RPC method: ${method}`);
        return Promise.resolve();
    }
  };

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request: RpcRequest;
    try {
      request = JSON.parse(trimmed) as RpcRequest;
    } catch {
      notify("error", { message: "invalid JSON request" });
      return;
    }
    if (
      typeof request !== "object" ||
      request === null ||
      typeof request.method !== "string"
    ) {
      replyError(request?.id, "invalid_params", "request requires a method");
      return;
    }
    const params =
      typeof request.params === "object" && request.params !== null
        ? request.params
        : {};
    const work = dispatch(request.id, request.method, params);
    if (request.method === "prompt") active = work;
  };

  const rl = createInterface({ input, terminal: false });
  rl.on("line", handleLine);
  await new Promise<void>((resolve) => rl.on("close", resolve));
  if (active) await active;
  return 0;
}

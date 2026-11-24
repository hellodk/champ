import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "stream";
import { runRpcServer, type RpcServerDeps } from "@/cli/rpc";
import type { TurnOutcome } from "@/cli/turn-runtime";

const success: TurnOutcome = {
  text: "done",
  aborted: false,
  status: "success",
};

async function serve(
  requests: Array<Record<string, unknown> | string>,
  overrides: Partial<RpcServerDeps> = {},
): Promise<Array<Record<string, unknown>>> {
  const input = new PassThrough();
  const output: string[] = [];
  const done = runRpcServer({
    execute: async (_text, events) => {
      events.onText?.("streamed ");
      events.onText?.("text");
      events.onUsage?.({ inputTokens: 3, outputTokens: 2 });
      return success;
    },
    abort: () => false,
    getState: () => ({ mode: "agent", model: "m" }),
    getSession: async () => ({ sessionId: "sess-1", messages: 1 }),
    setModel: async ({ model }) => ({ model, provider: "p" }),
    setMode: (mode) => ({ mode }),
    listTools: () => [{ name: "read_file" }],
    ...overrides,
    input,
    write: (line) => output.push(line),
  });
  for (const request of requests) {
    const line =
      typeof request === "string" && request.startsWith("raw:")
        ? request.slice(4)
        : JSON.stringify(request);
    input.write(`${line}\n`);
  }
  input.end();
  await done;
  return output.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("subprocess RPC", () => {
  it("answers requests with plain JSON objects and streams turn events", async () => {
    const lines = await serve([
      { id: 1, method: "prompt", params: { text: "hello" } },
      { id: 2, method: "get_state" },
      { id: 3, method: "get_session" },
      { id: 4, method: "list_tools" },
    ]);

    expect(lines).toContainEqual({
      method: "message.delta",
      params: { text: "streamed " },
    });
    expect(lines).toContainEqual({
      method: "usage",
      params: { inputTokens: 3, outputTokens: 2 },
    });
    expect(lines).toContainEqual({
      id: 1,
      ok: true,
      result: { text: "done", status: "success", aborted: false },
    });
    expect(lines).toContainEqual({
      id: 2,
      ok: true,
      result: {
        mode: "agent",
        model: "m",
        busy: false,
        aborting: false,
        protocol: 1,
      },
    });
    expect(lines).toContainEqual({
      id: 3,
      ok: true,
      result: { sessionId: "sess-1", messages: 1 },
    });
    expect(lines).toContainEqual({
      id: 4,
      ok: true,
      result: { tools: [{ name: "read_file" }] },
    });
  });

  it("rejects unknown methods and invalid parameters", async () => {
    const lines = await serve([
      { id: 1, method: "nope" },
      { id: 2, method: "prompt", params: {} },
      "raw:not json",
    ]);

    expect(lines).toContainEqual({
      id: 1,
      ok: false,
      error: { code: "unknown_method", message: "unknown RPC method: nope" },
    });
    expect(lines).toContainEqual({
      id: 2,
      ok: false,
      error: {
        code: "invalid_params",
        message: "prompt requires a non-empty text",
      },
    });
    expect(lines).toContainEqual({
      method: "error",
      params: { message: "invalid JSON request" },
    });
  });

  it("reports provider failures without turning the response into an error", async () => {
    const lines = await serve(
      [{ id: 1, method: "prompt", params: { text: "x" } }],
      {
        execute: async (_text, events) => {
          events.onError?.("Request failed: 404");
          return {
            text: "",
            error: "Request failed: 404",
            aborted: false,
            status: "failed",
          };
        },
      },
    );

    expect(lines).toContainEqual({
      method: "error",
      params: { message: "Request failed: 404" },
    });
    expect(lines).toContainEqual({
      id: 1,
      ok: true,
      result: {
        text: "",
        error: "Request failed: 404",
        aborted: false,
        status: "failed",
      },
    });
  });

  it("resolves a pending approval when approve_tool denies it", async () => {
    const lines = await serve(
      [
        { id: 1, method: "prompt", params: { text: "danger" } },
        {
          id: 2,
          method: "approve_tool",
          params: { approved: false, token: "approval-1" },
        },
      ],
      {
        execute: async (_text, _events, requestApproval) => {
          const approved = await requestApproval("delete a file");
          return {
            text: "",
            aborted: false,
            status: approved ? "success" : "cancelled",
          };
        },
      },
    );

    expect(lines).toContainEqual({
      method: "approval.required",
      params: { token: "approval-1", description: "delete a file" },
    });
    expect(lines).toContainEqual({
      id: 2,
      ok: true,
      result: { approved: false },
    });
    expect(lines).toContainEqual({
      id: 1,
      ok: true,
      result: { text: "", aborted: false, status: "cancelled" },
    });
  });

  it("aborts an active prompt and denies its pending approval", async () => {
    const abort = vi.fn(() => true);
    const lines = await serve(
      [
        { id: 1, method: "prompt", params: { text: "danger" } },
        { id: 2, method: "abort" },
        { id: 3, method: "approve_tool", params: { approved: true } },
      ],
      {
        abort,
        execute: async (_text, _events, requestApproval) => {
          const approved = await requestApproval("delete a file");
          return {
            text: "",
            aborted: !approved,
            status: approved ? "success" : "cancelled",
          };
        },
      },
    );

    expect(abort).toHaveBeenCalledOnce();
    expect(lines).toContainEqual({
      id: 2,
      ok: true,
      result: { aborted: true },
    });
    expect(lines).toContainEqual({
      id: 3,
      ok: false,
      error: {
        code: "no_pending_approval",
        message: "no approval is pending",
      },
    });
  });

  it("changes model and mode through the shared controller callbacks", async () => {
    const lines = await serve([
      { id: 1, method: "set_model", params: { model: "new-model" } },
      { id: 2, method: "set_mode", params: { mode: "plan" } },
    ]);

    expect(lines).toContainEqual({
      id: 1,
      ok: true,
      result: { model: "new-model", provider: "p" },
    });
    expect(lines).toContainEqual({ id: 2, ok: true, result: { mode: "plan" } });
  });

  it("rejects configuration changes while a prompt is running", async () => {
    const lines = await serve(
      [
        { id: 1, method: "prompt", params: { text: "danger" } },
        { id: 2, method: "set_model", params: { model: "other" } },
        { id: 3, method: "approve_tool", params: { approved: true } },
      ],
      {
        execute: async (_text, _events, requestApproval) => {
          const approved = await requestApproval("delete a file");
          return {
            text: "",
            aborted: false,
            status: approved ? "success" : "cancelled",
          };
        },
      },
    );

    expect(lines).toContainEqual({
      id: 2,
      ok: false,
      error: {
        code: "busy",
        message: "cannot change the model while a prompt is running",
      },
    });
    expect(lines).toContainEqual({
      id: 1,
      ok: true,
      result: { text: "", aborted: false, status: "success" },
    });
  });
});

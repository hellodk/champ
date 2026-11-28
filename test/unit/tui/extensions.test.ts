import { describe, expect, it } from "vitest";
import { contextBudget } from "@/tui/insights";
import { initialTuiState, tuiReducer } from "@/tui/state";

function start() {
  return initialTuiState({
    workspace: "/repo",
    model: "m",
    endpoints: [],
  });
}

describe("extended TUI state", () => {
  it("cycles through the new screens", () => {
    let state = start();
    const seen = new Set<string>();
    for (let index = 0; index < 12; index += 1) {
      state = tuiReducer(state, { type: "screen/next" });
      seen.add(state.screen);
    }
    for (const screen of ["tasks", "plan", "context", "usage", "mcp"]) {
      expect(seen.has(screen)).toBe(true);
    }
  });

  it("keeps the composer in sync with the prompt and clears it on submit", () => {
    let state = tuiReducer(start(), {
      type: "composer/insert",
      text: "line one\nline two",
    });
    expect(state.input).toBe("line one\nline two");
    state = tuiReducer(state, { type: "composer/move", move: "up" });
    expect(state.composer.row).toBe(0);
    state = tuiReducer(state, { type: "turn/start" });
    expect(state.input).toBe("");
    expect(state.composer.lines).toEqual([""]);
  });

  it("retains full structured tool events beyond the transcript summary", () => {
    let state = tuiReducer(start(), {
      type: "tool/start",
      event: {
        id: "t1",
        name: "read_file",
        args: "x".repeat(500),
      },
    });
    expect(
      state.messages.find((message) => message.role === "tool")?.text,
    ).toContain("read_file");
    expect(state.toolRecords.t1.start.args).toHaveLength(500);
    state = tuiReducer(state, {
      type: "tool/result",
      event: {
        id: "t1",
        name: "read_file",
        output: "y".repeat(500),
        stderr: "warning",
        success: true,
      },
    });
    expect(state.toolRecords.t1.result?.output).toHaveLength(500);
    expect(state.toolRecords.t1.result?.stderr).toBe("warning");
  });

  it("queues tasks and derives per-session execution state", () => {
    let state = tuiReducer(start(), {
      type: "tasks/enqueue",
      task: { id: "a", sessionId: "s1", label: "A" },
    });
    state = tuiReducer(state, { type: "tasks/start", sessionId: "s1" });
    expect(state.tasks[0].status).toBe("running");
    expect(state.sessionExecutions.s1).toBe("running");
    state = tuiReducer(state, {
      type: "tasks/finish",
      id: "a",
      status: "done",
    });
    expect(state.sessionExecutions.s1).toBe("idle");
  });

  it("stores plan, context, usage, MCP and recovery snapshots", () => {
    let state = tuiReducer(start(), {
      type: "plan/set",
      steps: [{ id: "1", text: "A", status: "pending" }],
    });
    expect(state.plan[0].status).toBe("active");
    state = tuiReducer(state, {
      type: "context/set",
      snapshot: {
        usedTokens: 10,
        limit: 100,
        model: "m",
        messages: 1,
        compactions: [],
      },
    });
    expect(contextBudget(state.context).remaining).toBe(90);
    state = tuiReducer(state, {
      type: "usage/add",
      record: {
        at: "now",
        model: "m",
        provider: "p",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        latencyMs: 10,
      },
    });
    expect(state.usage).toHaveLength(1);
    state = tuiReducer(state, {
      type: "mcp/set",
      servers: [
        {
          name: "fs",
          transport: "stdio",
          status: "running",
          health: "healthy",
          tools: 2,
        },
      ],
    });
    expect(state.mcpServers[0].name).toBe("fs");
    state = tuiReducer(state, {
      type: "recovery/record",
      snapshot: {
        id: "cp-1",
        label: "before edit",
        at: "now",
        checkpointId: "cp-1",
      },
    });
    expect(state.recovery.present.id).toBe("cp-1");
  });

  it("renames, forks and deletes sessions and manages tabs", () => {
    let state = tuiReducer(start(), {
      type: "sessions/set",
      sessions: [
        { id: "root", label: "Root", updatedAt: "1" },
        { id: "child", label: "Child", updatedAt: "2", parentId: "root" },
      ],
    });
    state = tuiReducer(state, {
      type: "sessions/rename",
      id: "child",
      label: "Renamed",
    });
    expect(state.sessions[1].label).toBe("Renamed");
    state = tuiReducer(state, {
      type: "sessions/fork",
      id: "child",
      newId: "fork",
      label: "Fork",
    });
    expect(state.sessions.find((item) => item.id === "fork")?.parentId).toBe(
      "child",
    );
    state = tuiReducer(state, { type: "sessions/tab/add", id: "fork" });
    expect(state.sessionTabs).toContain("fork");
    state = tuiReducer(state, { type: "sessions/delete", id: "root" });
    expect(state.sessions.some((item) => item.id === "root")).toBe(false);
    expect(
      state.sessions.find((item) => item.id === "child")?.parentId,
    ).toBeUndefined();
  });
});

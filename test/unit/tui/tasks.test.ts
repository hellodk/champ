import { describe, expect, it } from "vitest";
import {
  enqueueTask,
  finishTask,
  orderedTasks,
  startNextTask,
  taskStateForSession,
} from "@/tui/tasks";

const at = "2026-01-01T00:00:00.000Z";

describe("task queue", () => {
  it("runs queued tasks in order and tracks state per session", () => {
    let tasks = enqueueTask([], { id: "a", sessionId: "s1", label: "A" }, at);
    tasks = enqueueTask(tasks, { id: "b", sessionId: "s1", label: "B" }, at);
    tasks = enqueueTask(tasks, { id: "c", sessionId: "s2", label: "C" }, at);
    const started = startNextTask(tasks, "s1", at);
    expect(started.find((task) => task.id === "a")?.status).toBe("running");
    expect(started.find((task) => task.id === "b")?.status).toBe("queued");
    expect(taskStateForSession(started, "s2")).toBe("queued");
    const done = finishTask(started, "a", "done", at);
    expect(taskStateForSession(done, "s1")).toBe("queued");
  });

  it("keeps background tasks visible in the queue", () => {
    let tasks = enqueueTask(
      [],
      { id: "bg", sessionId: "s1", label: "bg", background: true },
      at,
    );
    tasks = startNextTask(tasks, "s1", at);
    expect(orderedTasks(tasks, "s1").map((task) => task.id)).toEqual(["bg"]);
    expect(tasks.find((task) => task.id === "bg")?.status).toBe("running");
  });

  it("fails a task without dropping it", () => {
    let tasks = enqueueTask([], { id: "x", sessionId: "s1", label: "X" }, at);
    tasks = finishTask(startNextTask(tasks, "s1", at), "x", "failed", at);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: "failed", finishedAt: at });
  });
});

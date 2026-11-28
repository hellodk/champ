/** Task queue with background tasks and per-session execution state. */
export type TaskStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TuiTaskInput {
  id: string;
  sessionId: string;
  label: string;
  background?: boolean;
}

export interface TuiTask extends TuiTaskInput {
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export type SessionExecutionState = "idle" | "queued" | "running";

export function enqueueTask(
  tasks: readonly TuiTask[],
  input: TuiTaskInput,
  now: string,
): TuiTask[] {
  return [...tasks, { ...input, status: "queued", createdAt: now }];
}

export function orderedTasks(
  tasks: readonly TuiTask[],
  sessionId?: string,
): TuiTask[] {
  return tasks.filter(
    (task) => sessionId === undefined || task.sessionId === sessionId,
  );
}

export function startNextTask(
  tasks: readonly TuiTask[],
  sessionId: string,
  now: string,
): TuiTask[] {
  let started = false;
  return tasks.map((task) => {
    if (!started && task.sessionId === sessionId && task.status === "queued") {
      started = true;
      return { ...task, status: "running", startedAt: now };
    }
    return task;
  });
}

export function finishTask(
  tasks: readonly TuiTask[],
  id: string,
  status: Extract<TaskStatus, "done" | "failed" | "cancelled">,
  now: string,
): TuiTask[] {
  return tasks.map((task) =>
    task.id === id ? { ...task, status, finishedAt: now } : task,
  );
}

export function taskStateForSession(
  tasks: readonly TuiTask[],
  sessionId: string,
): SessionExecutionState {
  const forSession = orderedTasks(tasks, sessionId);
  if (forSession.some((task) => task.status === "running")) return "running";
  if (forSession.some((task) => task.status === "queued")) return "queued";
  return "idle";
}

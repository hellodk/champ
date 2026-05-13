import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowSession } from "@/ui/workflow-session";
import type { WorkflowMode } from "@/ui/workflow-store";

function makeRunner(opts: { willFail?: boolean; slow?: boolean } = {}) {
  return {
    run: vi
      .fn()
      .mockImplementation(
        async (
          _req: string,
          options: { onProgress?: (e: any) => void; abortSignal?: AbortSignal },
        ) => {
          if (opts.slow) {
            await new Promise<void>((resolve) => {
              const check = () => {
                if (options.abortSignal?.aborted) resolve();
                else setTimeout(check, 5);
              };
              setTimeout(check, 5);
            });
            return {
              success: false,
              output: "aborted",
              diffs: [],
              executionLog: [],
            };
          }
          options.onProgress?.({
            type: "agent_started",
            agentName: "planner",
            step: 1,
            totalSteps: 1,
          });
          options.onProgress?.({
            type: "agent_completed",
            agentName: "planner",
            durationMs: 100,
            success: true,
            output: "done",
          });
          return {
            success: !opts.willFail,
            output: "finished",
            diffs: [],
            executionLog: [],
          };
        },
      ),
    getOrchestrator: vi
      .fn()
      .mockReturnValue({ listAgents: vi.fn().mockReturnValue([]) }),
  } as any;
}

function makeStore() {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    loadAll: vi.fn().mockResolvedValue([]),
    pruneIfNeeded: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("WorkflowSession", () => {
  it("transitions status from running to completed on success", async () => {
    const session = new WorkflowSession(
      makeStore(),
      makeRunner(),
      "r1",
      "Test run",
      "safe",
    );
    const statuses: string[] = [];
    session.onStatusChange((run) => statuses.push(run.status));
    await session.start("build feature");
    expect(statuses).toContain("running");
    expect(statuses[statuses.length - 1]).toBe("completed");
  });

  it("transitions to failed when runner reports failure", async () => {
    const session = new WorkflowSession(
      makeStore(),
      makeRunner({ willFail: true }),
      "r1",
      "Test",
      "auto",
    );
    let last = "";
    session.onStatusChange((run) => {
      last = run.status;
    });
    await session.start("task");
    expect(last).toBe("failed");
  });

  it("resolves approval gate when approve() is called", async () => {
    const session = new WorkflowSession(
      makeStore(),
      makeRunner(),
      "r1",
      "Test",
      "audit",
    );
    setTimeout(() => void session.approve(), 0);
    const decision = await session.waitForApproval("code");
    expect(decision).toBe("approve");
  });

  it("stop() aborts run and sets status to stopped", async () => {
    const session = new WorkflowSession(
      makeStore(),
      makeRunner({ slow: true }),
      "r1",
      "Slow",
      "auto",
    );
    const statuses: string[] = [];
    session.onStatusChange((run) => {
      statuses.push(run.status);
    });
    const startPromise = session.start("long task");
    await new Promise((r) => setTimeout(r, 15));
    session.stop();
    await startPromise;
    expect(statuses).toContain("stopped");
  });

  it("acceptFile marks a file change as accepted", async () => {
    const session = new WorkflowSession(
      makeStore(),
      makeRunner(),
      "r1",
      "Test",
      "safe",
    );
    // Manually inject a file change
    (session as any).run.filesChanged = [
      {
        filePath: "src/foo.ts",
        oldContent: "old",
        newContent: "new",
        status: "pending",
      },
    ];
    session.acceptFile("src/foo.ts");
    expect(session.getSnapshot().filesChanged[0].status).toBe("accepted");
  });

  it("rejectFile marks a file change as rejected", async () => {
    const session = new WorkflowSession(
      makeStore(),
      makeRunner(),
      "r1",
      "Test",
      "safe",
    );
    (session as any).run.filesChanged = [
      {
        filePath: "src/bar.ts",
        oldContent: "old",
        newContent: "new",
        status: "pending",
      },
    ];
    session.rejectFile("src/bar.ts");
    expect(session.getSnapshot().filesChanged[0].status).toBe("rejected");
  });
});

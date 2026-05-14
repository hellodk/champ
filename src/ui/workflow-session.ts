import type { MultiAgentRunner } from "../agent/multi-agent-runner";
import {
  WorkflowStore,
  type WorkflowRun,
  type WorkflowMode,
} from "./workflow-store";
import type { Diff } from "../agent/agents/types";

type ApprovalDecision = "approve" | "skip" | "stop";

export class WorkflowSession {
  private run: WorkflowRun;
  private abortController = new AbortController();
  private statusListeners: Array<(run: WorkflowRun) => void> = [];
  private pendingApproval: {
    resolve: (decision: ApprovalDecision) => void;
  } | null = null;

  constructor(
    private readonly store: WorkflowStore,
    private readonly runner: MultiAgentRunner,
    id: string,
    name: string,
    mode: WorkflowMode,
  ) {
    this.run = {
      id,
      name,
      status: "running",
      mode,
      startTime: Date.now(),
      steps: [],
      filesChanged: [],
    };
  }

  onStatusChange(listener: (run: WorkflowRun) => void): void {
    this.statusListeners.push(listener);
  }

  getSnapshot(): WorkflowRun {
    return {
      ...this.run,
      steps: this.run.steps.map((s) => ({ ...s })),
      filesChanged: this.run.filesChanged.map((f) => ({ ...f })),
    };
  }

  async start(userRequest: string): Promise<void> {
    this.emit();
    try {
      const result = await this.runner.run(userRequest, {
        abortSignal: this.abortController.signal,
        onProgress: (event) => {
          if (event.type === "agent_started") {
            this.run.steps.push({
              agentName: event.agentName,
              status: "running",
              startTime: Date.now(),
            });
            this.emit();
          } else if (event.type === "agent_completed") {
            const step = this.run.steps.find(
              (s) => s.agentName === event.agentName && s.status === "running",
            );
            if (step) {
              step.status = "completed";
              step.endTime = Date.now();
              step.output = event.output;
            }
            this.emit();
          } else if (event.type === "agent_failed") {
            const step = this.run.steps.find(
              (s) => s.agentName === event.agentName && s.status === "running",
            );
            if (step) {
              step.status = "failed";
              step.endTime = Date.now();
              step.error = event.error;
            }
            this.emit();
          }
        },
      });

      // Extract diffs from workflow result — CodeAgent outputs diffs[]
      if (result.diffs?.length) {
        this.run.filesChanged = (result.diffs as Diff[]).map((d) => ({
          filePath: d.filePath,
          oldContent: d.oldContent,
          newContent: d.newContent,
          status: "pending" as const,
        }));
      }

      this.run.status = result.success ? "completed" : "failed";
      this.run.endTime = Date.now();
    } catch {
      this.run.status = this.abortController.signal.aborted
        ? "stopped"
        : "failed";
      this.run.endTime = Date.now();
    }
    this.emit();
    void this.store.save(this.run);
    void this.store.pruneIfNeeded();
  }

  async approve(): Promise<void> {
    if (this.pendingApproval) {
      this.pendingApproval.resolve("approve");
      this.pendingApproval = null;
    }
  }

  async skipAgent(): Promise<void> {
    if (this.pendingApproval) {
      this.pendingApproval.resolve("skip");
      this.pendingApproval = null;
    }
  }

  stop(): void {
    this.abortController.abort();
    if (this.pendingApproval) {
      this.pendingApproval.resolve("stop");
      this.pendingApproval = null;
    }
    if (
      this.run.status === "running" ||
      this.run.status === "awaiting-approval"
    ) {
      this.run.status = "stopped";
      this.run.endTime = Date.now();
      this.emit();
      void this.store.save(this.run);
    }
  }

  async waitForApproval(agentName: string): Promise<ApprovalDecision> {
    this.run.status = "awaiting-approval";
    const step = this.run.steps.find(
      (s) => s.agentName === agentName && s.status === "running",
    );
    if (step) step.status = "awaiting-approval";
    this.emit();
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      this.pendingApproval = { resolve };
    });
    // Only resume if the user approved or skipped — stop() already set
    // the status to "stopped", so don't overwrite it here.
    if (decision !== "stop") {
      this.run.status = "running";
      if (step) step.status = decision === "skip" ? "skipped" : "running";
    }
    this.emit();
    return decision;
  }

  acceptFile(filePath: string): void {
    const change = this.run.filesChanged.find((f) => f.filePath === filePath);
    if (change) change.status = "accepted";
    this.emit();
    void this.store.save(this.run);
  }

  rejectFile(filePath: string): void {
    const change = this.run.filesChanged.find((f) => f.filePath === filePath);
    if (change) change.status = "rejected";
    this.emit();
    void this.store.save(this.run);
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.statusListeners) listener(snapshot);
  }
}

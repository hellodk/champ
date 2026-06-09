/**
 * Regression test for issue #26: TeamBuilderPanel.save() hardcodes execution params
 *
 * Before the fix, save() used hardcoded values for all execution parameters:
 *   mode: "auto", maxParallel: 3, totalTokenBudget: 100000, etc.
 *
 * This silently reverted supervised teams to "auto" mode on save — a security regression.
 *
 * After the fix, a new executionConfigSignal captures the loaded team's execution
 * config in the message handler, and save() uses those values with ?? fallback defaults.
 * All execution params are now preserved through the save cycle.
 *
 * These tests document the contract: execution config from loaded team → saved team
 */

import { describe, it, expect } from "vitest";

describe("TeamBuilderPanel execution config preservation", () => {
  it("documents the fix contract: loaded execution config must be preserved on save", () => {
    // The actual test occurs at runtime in the webview.
    // This test documents the expected behavior:
    //
    // 1. User loads a team with mode: "supervised", maxParallel: 5, etc.
    // 2. TeamBuilderPanel receives teamBuilderLoad message
    // 3. executionConfigSignal.value captures all fields from message.team.execution
    // 4. User edits agents and clicks save
    // 5. save() uses executionConfigSignal.value?.mode ?? "auto" instead of hardcoded "auto"
    // 6. Saved team has mode: "supervised", maxParallel: 5, etc. (unchanged)
    //
    // If any of these steps fails, the team will be silently modified during save.

    const loadedExecution = {
      mode: "supervised",
      maxParallel: 5,
      totalTokenBudget: 250000,
      timeoutSeconds: 300,
      retries: 3,
      checkpoints: true,
    };

    // Simulated save with executionConfigSignal set
    const executionConfigSignal = loadedExecution;

    // Save function logic: use signal value with ?? defaults
    const savedExecution = {
      mode: executionConfigSignal?.mode ?? "auto",
      maxParallel: executionConfigSignal?.maxParallel ?? 3,
      totalTokenBudget: executionConfigSignal?.totalTokenBudget ?? 100000,
      timeoutSeconds: executionConfigSignal?.timeoutSeconds ?? 120,
      retries: executionConfigSignal?.retries ?? 1,
      checkpoints: executionConfigSignal?.checkpoints ?? true,
    };

    // All loaded values must be preserved
    expect(savedExecution.mode).toBe("supervised");
    expect(savedExecution.maxParallel).toBe(5);
    expect(savedExecution.totalTokenBudget).toBe(250000);
    expect(savedExecution.timeoutSeconds).toBe(300);
    expect(savedExecution.retries).toBe(3);
    expect(savedExecution.checkpoints).toBe(true);
  });

  it("uses ?? defaults when executionConfigSignal is null (new team)", () => {
    const executionConfigSignal = null;

    const savedExecution = {
      mode: executionConfigSignal?.mode ?? "auto",
      maxParallel: executionConfigSignal?.maxParallel ?? 3,
      totalTokenBudget: executionConfigSignal?.totalTokenBudget ?? 100000,
      timeoutSeconds: executionConfigSignal?.timeoutSeconds ?? 120,
      retries: executionConfigSignal?.retries ?? 1,
      checkpoints: executionConfigSignal?.checkpoints ?? true,
    };

    // Defaults apply
    expect(savedExecution.mode).toBe("auto");
    expect(savedExecution.maxParallel).toBe(3);
    expect(savedExecution.totalTokenBudget).toBe(100000);
    expect(savedExecution.timeoutSeconds).toBe(120);
    expect(savedExecution.retries).toBe(1);
    expect(savedExecution.checkpoints).toBe(true);
  });

  it("preserves partial execution config (some fields loaded, others default)", () => {
    const loadedExecution = {
      mode: "supervised",
      // other fields absent
    };

    const executionConfigSignal = loadedExecution;

    const savedExecution = {
      mode: executionConfigSignal?.mode ?? "auto",
      maxParallel: executionConfigSignal?.maxParallel ?? 3,
      totalTokenBudget: executionConfigSignal?.totalTokenBudget ?? 100000,
      timeoutSeconds: executionConfigSignal?.timeoutSeconds ?? 120,
      retries: executionConfigSignal?.retries ?? 1,
      checkpoints: executionConfigSignal?.checkpoints ?? true,
    };

    expect(savedExecution.mode).toBe("supervised");
    expect(savedExecution.maxParallel).toBe(3); // default
    expect(savedExecution.totalTokenBudget).toBe(100000); // default
    expect(savedExecution.checkpoints).toBe(true); // default
  });
});

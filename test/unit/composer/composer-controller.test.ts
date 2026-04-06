/**
 * TDD: Tests for ComposerController.
 * Plan -> Diff -> Apply workflow with git integration.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ComposerController } from "@/composer/composer-controller";

describe("ComposerController", () => {
  let composer: ComposerController;

  beforeEach(() => {
    composer = new ComposerController({
      orchestrator: {
        registerAgent: vi.fn(),
        executeWorkflow: vi.fn().mockResolvedValue({
          success: true,
          diffs: [
            { filePath: "src/a.ts", oldContent: "old a", newContent: "new a" },
            { filePath: "src/b.ts", oldContent: "old b", newContent: "new b" },
          ],
          plan: {
            steps: [
              { step: 1, description: "Edit a.ts" },
              { step: 2, description: "Edit b.ts" },
            ],
          },
          executionLog: [],
        }),
      } as any,
      gitIntegration: {
        createBranch: vi.fn().mockResolvedValue("aidev/fix-123"),
        commit: vi.fn().mockResolvedValue("abc1234"),
        rollback: vi.fn().mockResolvedValue(undefined),
      } as any,
    });
  });

  it("should generate a plan from user request", async () => {
    const plan = await composer.generatePlan("Fix the login bug");
    expect(plan).toBeDefined();
    expect(plan.steps.length).toBeGreaterThan(0);
  });

  it("should generate diffs for all affected files", async () => {
    const result = await composer.generateDiffs("Fix the login bug");
    expect(result.diffs).toHaveLength(2);
    expect(result.diffs[0].filePath).toBe("src/a.ts");
    expect(result.diffs[1].filePath).toBe("src/b.ts");
  });

  it("should apply approved diffs", async () => {
    const result = await composer.generateDiffs("Fix bug");
    const applyResult = await composer.applyDiffs(result.diffs, {
      approved: [0, 1], // approve both
    });

    expect(applyResult.success).toBe(true);
    expect(applyResult.filesModified).toHaveLength(2);
  });

  it("should apply partial diffs (per-file approval)", async () => {
    const result = await composer.generateDiffs("Fix bug");
    const applyResult = await composer.applyDiffs(result.diffs, {
      approved: [0], // approve only first
      rejected: [1], // reject second
    });

    expect(applyResult.filesModified).toHaveLength(1);
    expect(applyResult.filesSkipped).toHaveLength(1);
  });

  it("should auto-create git branch on apply", async () => {
    const result = await composer.generateDiffs("Fix bug");
    await composer.applyDiffs(result.diffs, {
      approved: [0, 1],
      createBranch: true,
    });

    expect(composer["deps"].gitIntegration.createBranch).toHaveBeenCalled();
  });

  it("should auto-commit after applying", async () => {
    const result = await composer.generateDiffs("Fix bug");
    await composer.applyDiffs(result.diffs, {
      approved: [0, 1],
      autoCommit: true,
    });

    expect(composer["deps"].gitIntegration.commit).toHaveBeenCalled();
  });

  it("should support rollback", async () => {
    const result = await composer.generateDiffs("Fix bug");
    await composer.applyDiffs(result.diffs, { approved: [0, 1] });
    await composer.rollback();

    expect(composer["deps"].gitIntegration.rollback).toHaveBeenCalled();
  });
});

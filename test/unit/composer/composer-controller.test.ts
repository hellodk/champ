/**
 * TDD: Tests for ComposerController.
 * Plan -> Diff -> Apply workflow with git integration.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { ComposerController } from "@/composer/composer-controller";
import * as vscode from "vscode";

describe("ComposerController", () => {
  let composer: ComposerController;

  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Default mock: files exist with their test content
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockImplementation(async (uri: any) => {
      // Default: return file content matching the diffs in the tests
      const path = uri.fsPath || String(uri);
      if (path.includes("a.ts")) {
        return new TextEncoder().encode("old a");
      } else if (path.includes("b.ts")) {
        return new TextEncoder().encode("old b");
      } else if (path.includes("c.ts")) {
        return new TextEncoder().encode("old c");
      }
      return new TextEncoder().encode("default content");
    });

    // Mock writeFile to succeed
    (
      vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(undefined);

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
        createBranch: vi.fn().mockResolvedValue("champ/fix-123"),
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

  describe("Atomic transactional multi-file edits", () => {
    it("should validate all diffs before applying any (pre-flight check)", async () => {
      // Mock readFile to return content for a.ts but different content for b.ts
      (
        vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
      ).mockImplementation(async (uri: any) => {
        const path = uri.fsPath || String(uri);
        if (path.includes("a.ts")) {
          return new TextEncoder().encode("old a");
        }
        // Return different content for b.ts, so validation fails
        return new TextEncoder().encode("different content");
      });

      // Create a scenario where the second diff has an invalid old_content
      const diffs = [
        {
          filePath: "src/a.ts",
          oldContent: "old a",
          newContent: "new a",
        },
        {
          filePath: "src/b.ts",
          oldContent: "old b THAT DOES NOT EXIST",
          newContent: "new b",
        },
      ];

      const applyResult = await composer.applyDiffs(diffs, {
        approved: [0, 1],
      });

      // The apply should fail BEFORE any file is modified
      expect(applyResult.success).toBe(false);
      expect(applyResult.filesModified).toHaveLength(0);
      expect(applyResult.errors.length).toBeGreaterThan(0);
    });

    it("should provide validation results with specific file errors", async () => {
      // Mock readFile to return content for a.ts but different content for b.ts
      (
        vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
      ).mockImplementation(async (uri: any) => {
        const path = uri.fsPath || String(uri);
        if (path.includes("a.ts")) {
          return new TextEncoder().encode("old a");
        }
        // Return different content for b.ts
        return new TextEncoder().encode("different b content");
      });

      const diffs = [
        {
          filePath: "src/a.ts",
          oldContent: "old a",
          newContent: "new a",
        },
        {
          filePath: "src/b.ts",
          oldContent: "old b INVALID",
          newContent: "new b",
        },
      ];

      const applyResult = await composer.applyDiffs(diffs, {
        approved: [0, 1],
      });

      expect(applyResult.success).toBe(false);
      // Should include validation error details
      expect(applyResult.errors.some((e) => e.includes("src/b.ts"))).toBe(true);
    });

    it("should rollback if branch was created and validation fails", async () => {
      // Mock readFile to return content for a.ts but different content for b.ts
      (
        vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
      ).mockImplementation(async (uri: any) => {
        const path = uri.fsPath || String(uri);
        if (path.includes("a.ts")) {
          return new TextEncoder().encode("old a");
        }
        // Return different content for b.ts
        return new TextEncoder().encode("different b");
      });

      const diffs = [
        {
          filePath: "src/a.ts",
          oldContent: "old a",
          newContent: "new a",
        },
        {
          filePath: "src/b.ts",
          oldContent: "INVALID old b",
          newContent: "new b",
        },
      ];

      const applyResult = await composer.applyDiffs(diffs, {
        approved: [0, 1],
        createBranch: true,
      });

      expect(applyResult.success).toBe(false);
      // Branch was created, so rollback should have been called
      expect(composer["deps"].gitIntegration.rollback).toHaveBeenCalled();
    });

    it("should apply all diffs together (all-or-nothing semantics)", async () => {
      const diffs = [
        {
          filePath: "src/a.ts",
          oldContent: "old a",
          newContent: "new a",
        },
        {
          filePath: "src/b.ts",
          oldContent: "old b",
          newContent: "new b",
        },
        {
          filePath: "src/c.ts",
          oldContent: "old c",
          newContent: "new c",
        },
      ];

      const applyResult = await composer.applyDiffs(diffs, {
        approved: [0, 1, 2],
      });

      // All should be applied together
      expect(applyResult.success).toBe(true);
      expect(applyResult.filesModified).toHaveLength(3);
      expect(applyResult.filesSkipped).toHaveLength(0);
    });

    it("should provide atomic transaction status in result", async () => {
      const diffs = [
        {
          filePath: "src/a.ts",
          oldContent: "old a",
          newContent: "new a",
        },
        {
          filePath: "src/b.ts",
          oldContent: "old b",
          newContent: "new b",
        },
      ];

      const applyResult = await composer.applyDiffs(diffs, {
        approved: [0, 1],
      });

      // Result should indicate atomic transaction status
      expect(applyResult).toHaveProperty("transactionStatus");
      if (applyResult.success) {
        expect(applyResult.transactionStatus).toBe("committed");
      }
    });
  });
});

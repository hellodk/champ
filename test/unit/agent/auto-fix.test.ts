/**
 * TDD: Tests for AutoFixService.
 * LSP diagnostics auto-fix loop: detect -> fix -> verify, max 3 iterations.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AutoFixService } from "@/agent/auto-fix";
import * as vscode from "vscode";

describe("AutoFixService", () => {
  let service: AutoFixService;
  let mockAgentController: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentController = {
      isActiveSession: vi.fn().mockReturnValue(true),
      getLastModifiedFiles: vi.fn().mockReturnValue(["src/main.ts"]),
      injectSystemMessage: vi.fn().mockResolvedValue(undefined),
      runAgentLoop: vi.fn().mockResolvedValue(undefined),
      postMessageToUI: vi.fn(),
    };
    service = new AutoFixService(mockAgentController);
  });

  it("should detect errors in modified files", () => {
    (
      vscode.languages.getDiagnostics as ReturnType<typeof vi.fn>
    ).mockReturnValue([
      {
        severity: vscode.DiagnosticSeverity.Error,
        message: "Type error",
        range: new vscode.Range(
          new vscode.Position(5, 0),
          new vscode.Position(5, 10),
        ),
        source: "ts",
      },
    ]);

    const errors = service.checkForErrors(["src/main.ts"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].diagnostics[0].message).toBe("Type error");
  });

  it("should trigger auto-fix loop when errors detected", async () => {
    await service.runAutoFixLoop([
      {
        filePath: "src/main.ts",
        diagnostics: [
          {
            severity: 0,
            message: "Type error",
            range: new vscode.Range(
              new vscode.Position(1, 0),
              new vscode.Position(1, 5),
            ),
            source: "ts",
          },
        ],
      },
    ]);

    expect(mockAgentController.injectSystemMessage).toHaveBeenCalled();
    expect(mockAgentController.runAgentLoop).toHaveBeenCalled();
  });

  it("should stop after max iterations (3)", async () => {
    // Errors persist across all iterations
    (
      vscode.languages.getDiagnostics as ReturnType<typeof vi.fn>
    ).mockReturnValue([
      {
        severity: 0,
        message: "Persistent error",
        range: new vscode.Range(
          new vscode.Position(1, 0),
          new vscode.Position(1, 5),
        ),
        source: "ts",
      },
    ]);

    await service.runAutoFixLoop([
      {
        filePath: "src/main.ts",
        diagnostics: [
          {
            severity: 0,
            message: "Persistent error",
            range: new vscode.Range(
              new vscode.Position(1, 0),
              new vscode.Position(1, 5),
            ),
            source: "ts",
          },
        ],
      },
    ]);

    expect(mockAgentController.runAgentLoop).toHaveBeenCalledTimes(3);
    expect(mockAgentController.postMessageToUI).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
  });

  it("should stop early when errors are resolved", async () => {
    let iteration = 0;
    (
      vscode.languages.getDiagnostics as ReturnType<typeof vi.fn>
    ).mockImplementation(() => {
      iteration++;
      if (iteration >= 2) return []; // errors fixed on second iteration
      return [
        {
          severity: 0,
          message: "Error",
          range: new vscode.Range(
            new vscode.Position(1, 0),
            new vscode.Position(1, 5),
          ),
          source: "ts",
        },
      ];
    });

    await service.runAutoFixLoop([
      {
        filePath: "src/main.ts",
        diagnostics: [
          {
            severity: 0,
            message: "Error",
            range: new vscode.Range(
              new vscode.Position(1, 0),
              new vscode.Position(1, 5),
            ),
            source: "ts",
          },
        ],
      },
    ]);

    // Should not reach max iterations
    expect(mockAgentController.runAgentLoop).toHaveBeenCalledTimes(1);
  });

  it("should skip when no active session", () => {
    mockAgentController.isActiveSession.mockReturnValue(false);
    const errors = service.checkForErrors(["src/main.ts"]);
    expect(errors).toHaveLength(0);
  });
});

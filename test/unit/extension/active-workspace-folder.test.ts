import { describe, it, expect, vi, beforeEach } from "vitest";

// Lightweight mock of the vscode module used in tests
const mockFolders: Array<{ uri: { fsPath: string } }> = [];
let mockActiveEditorUri: string | undefined;

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return mockFolders.length ? mockFolders : undefined;
    },
    getWorkspaceFolder(uri: { fsPath: string }) {
      return (
        mockFolders.find((f) => uri.fsPath.startsWith(f.uri.fsPath)) ??
        undefined
      );
    },
  },
  window: {
    get activeTextEditor() {
      return mockActiveEditorUri
        ? { document: { uri: { fsPath: mockActiveEditorUri } } }
        : undefined;
    },
  },
}));

// Import after mock is set up
import { resolveActiveWorkspaceFolder } from "../../../src/extension-utils";

beforeEach(() => {
  mockFolders.length = 0;
  mockActiveEditorUri = undefined;
});

describe("resolveActiveWorkspaceFolder", () => {
  it("returns undefined when no workspace folders are open", () => {
    expect(resolveActiveWorkspaceFolder()).toBeUndefined();
  });

  it("returns workspaceFolders[0] when no editor is active", () => {
    mockFolders.push({ uri: { fsPath: "/projects/alpha" } });
    mockFolders.push({ uri: { fsPath: "/projects/beta" } });
    expect(resolveActiveWorkspaceFolder()).toBe("/projects/alpha");
  });

  it("returns the folder that owns the active editor file", () => {
    mockFolders.push({ uri: { fsPath: "/projects/alpha" } });
    mockFolders.push({ uri: { fsPath: "/projects/beta" } });
    mockActiveEditorUri = "/projects/beta/src/main.ts";
    expect(resolveActiveWorkspaceFolder()).toBe("/projects/beta");
  });

  it("falls back to workspaceFolders[0] when active file is outside all folders", () => {
    mockFolders.push({ uri: { fsPath: "/projects/alpha" } });
    mockActiveEditorUri = "/tmp/scratch.ts";
    expect(resolveActiveWorkspaceFolder()).toBe("/projects/alpha");
  });
});

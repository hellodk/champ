import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/preact";
import { h, Fragment } from "preact";

const mockPostMessage = vi.fn();
beforeEach(() => {
  (window as unknown as Record<string, unknown>).vscode = {
    postMessage: mockPostMessage,
  };
  mockPostMessage.mockClear();
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).vscode;
});

import { splitHunks } from "../utils/diff";

describe("splitHunks", () => {
  it("returns empty array for identical content", () => {
    expect(splitHunks("same\ncontent", "same\ncontent")).toEqual([]);
  });

  it("returns one hunk for a single-line change", () => {
    const hunks = splitHunks("line1\nold\nline3", "line1\nnew\nline3");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].removedLines).toEqual(["old"]);
    expect(hunks[0].addedLines).toEqual(["new"]);
  });

  it("removedLines contains old content, addedLines contains new content", () => {
    const hunks = splitHunks("a\nb", "a\nc");
    expect(hunks[0].removedLines).toContain("b");
    expect(hunks[0].addedLines).toContain("c");
  });

  it("two disjoint changes produce two hunks", () => {
    const hunks = splitHunks("a\nb\nc\nd\ne", "A\nb\nc\nd\nE");
    expect(hunks).toHaveLength(2);
  });
});

import { DiffOverlayPanel, editsSignal } from "../components/DiffOverlayPanel";

describe("DiffOverlayPanel", () => {
  beforeEach(() => {
    editsSignal.value = [];
  });

  it("renders nothing when edits signal is empty", () => {
    const { container } = render(<DiffOverlayPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders file count label when edits has entries", () => {
    editsSignal.value = [
      { path: "src/foo.ts", oldContent: "old", newContent: "new" },
    ];
    render(<DiffOverlayPanel />);
    expect(screen.getByText(/Champ Edits \(1 file\)/)).toBeTruthy();
  });

  it("Accept All button calls vscode.postMessage with { type: 'acceptAllEdits' }", () => {
    editsSignal.value = [
      { path: "src/foo.ts", oldContent: "old", newContent: "new" },
    ];
    render(<DiffOverlayPanel />);
    const btn = screen.getByText(/Accept All/);
    fireEvent.click(btn);
    expect(mockPostMessage).toHaveBeenCalledWith({ type: "acceptAllEdits" });
  });

  it("Reject All button calls vscode.postMessage with { type: 'revertAllEdits' }", () => {
    editsSignal.value = [
      { path: "src/bar.ts", oldContent: "a\nb", newContent: "a\nc" },
    ];
    render(<DiffOverlayPanel />);
    const btn = screen.getByText(/Reject All/);
    fireEvent.click(btn);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "revertAllEdits" }),
    );
  });
});

import {
  AgentGraphPanel,
  teamStateSignal,
} from "../components/AgentGraphPanel";
import type { TeamRunState, TeamAgentRunState } from "../types";

const MOCK_AGENT: TeamAgentRunState = {
  id: "agent-1",
  name: "Test Agent",
  status: "running",
  output: "",
  tokenCount: 100,
  validationWarnings: [],
  retryCount: 0,
};

const MOCK_TEAM_STATE: TeamRunState = {
  runId: "run-1",
  teamName: "Test Team",
  userRequest: "Do something",
  status: "running",
  agents: [MOCK_AGENT],
  sharedMemorySnapshot: {},
  startTime: Date.now(),
  totalTokens: 100,
  filesChanged: [],
  mode: "auto",
};

describe("AgentGraphPanel", () => {
  beforeEach(() => {
    teamStateSignal.value = null;
  });

  it("renders nothing when teamState is null", () => {
    const { container } = render(<AgentGraphPanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders SVG node for each agent when teamState is set", () => {
    teamStateSignal.value = MOCK_TEAM_STATE;
    const { container } = render(<AgentGraphPanel />);
    const svgEl = container.querySelector("svg");
    expect(svgEl).toBeTruthy();
    expect(screen.getByText("Test Agent")).toBeTruthy();
  });

  it("agent node shows 'running' status text", () => {
    teamStateSignal.value = MOCK_TEAM_STATE;
    render(<AgentGraphPanel />);
    // Status appears in agent name heading and status line; at least one element has "running"
    const statusEls = screen.getAllByText(/running/);
    expect(statusEls.length).toBeGreaterThan(0);
  });

  it("clicking a node calls vscode.postMessage with { type: 'focusTeamAgent', agentId }", () => {
    teamStateSignal.value = MOCK_TEAM_STATE;
    const { container } = render(<AgentGraphPanel />);
    // Try clicking the SVG g element; in jsdom SVG events may need clicking the rect child
    const rectEl = container.querySelector("rect");
    if (rectEl) fireEvent.click(rectEl);
    else {
      const nodeGroup = container.querySelector("g");
      if (nodeGroup) fireEvent.click(nodeGroup);
    }
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "focusTeamAgent", agentId: "agent-1" }),
    );
  });
});

describe("AgentGraphPanel Timeline tab", () => {
  it("renders Graph and Timeline tab buttons when state is set", () => {
    teamStateSignal.value = {
      runId: "r1",
      teamName: "T",
      userRequest: "task",
      status: "completed",
      agents: [
        {
          id: "a1",
          name: "Alpha",
          status: "done",
          output: "Alpha finished",
          startTime: 1000,
          endTime: 4500,
          tokenCount: 1200,
          validationWarnings: [],
          retryCount: 0,
        },
      ],
      sharedMemorySnapshot: {},
      startTime: 1000,
      endTime: 4500,
      totalTokens: 1200,
      filesChanged: [],
      mode: "auto",
    };
    const { container } = render(<AgentGraphPanel />);
    const buttons = Array.from(container.querySelectorAll("button")).map(
      (b) => b.textContent ?? "",
    );
    expect(buttons).toContain("Graph");
    expect(buttons).toContain("Timeline");
    teamStateSignal.value = null;
  });
});

import {
  McpMarketplacePanel,
  isOpenSignal,
  entriesSignal,
} from "../components/McpMarketplacePanel";
import type { McpMarketplaceEntry } from "../types";

const MOCK_ENTRY: McpMarketplaceEntry = {
  name: "sqlite",
  description: "Query SQLite databases",
  author: "anthropics",
  url: "https://example.com",
  transport: "stdio",
  command: "uvx",
  args: ["mcp-server-sqlite"],
  tags: ["database", "sql"],
};

describe("McpMarketplacePanel", () => {
  beforeEach(() => {
    isOpenSignal.value = false;
    entriesSignal.value = [];
  });

  it("renders nothing when isOpen is false", () => {
    const { container } = render(<McpMarketplacePanel />);
    expect(container.firstChild).toBeNull();
  });

  it("renders after isOpenSignal is set to true", () => {
    isOpenSignal.value = true;
    entriesSignal.value = [MOCK_ENTRY];
    render(<McpMarketplacePanel />);
    expect(screen.getByText("MCP Server Marketplace")).toBeTruthy();
  });

  it("Install button calls vscode.postMessage with { type: 'mcpMarketplaceInstall', entry }", () => {
    isOpenSignal.value = true;
    entriesSignal.value = [MOCK_ENTRY];
    render(<McpMarketplacePanel />);
    const installBtn = screen.getByText("Install");
    fireEvent.click(installBtn);
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mcpMarketplaceInstall",
        entry: MOCK_ENTRY,
      }),
    );
  });

  it("search query filters entries by name", () => {
    isOpenSignal.value = true;
    entriesSignal.value = [
      MOCK_ENTRY,
      {
        name: "postgres",
        description: "PostgreSQL queries",
        author: "anthropics",
        url: "https://example.com",
        transport: "stdio",
        command: "npx",
        args: [],
        tags: ["database"],
      },
    ];
    render(<McpMarketplacePanel />);
    const searchInput = screen.getByPlaceholderText("Search servers...");
    fireEvent.input(searchInput, { target: { value: "sqlite" } });
    expect(screen.queryByText("postgres")).toBeNull();
    expect(screen.getByText("sqlite")).toBeTruthy();
  });

  it("search query filters entries by tag", () => {
    isOpenSignal.value = true;
    entriesSignal.value = [
      MOCK_ENTRY,
      {
        name: "brave-search",
        description: "Web search",
        author: "anthropics",
        url: "https://example.com",
        transport: "stdio",
        command: "npx",
        args: [],
        tags: ["search", "web"],
      },
    ];
    render(<McpMarketplacePanel />);
    const searchInput = screen.getByPlaceholderText("Search servers...");
    fireEvent.input(searchInput, { target: { value: "web" } });
    expect(screen.queryByText("sqlite")).toBeNull();
    expect(screen.getByText("brave-search")).toBeTruthy();
  });
});

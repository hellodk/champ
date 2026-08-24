/**
 * AgentGraphPanel live-mode dependency edges (#112).
 *
 * Bug: live mode built dependsOnMap with an empty array per agent, so
 * EdgeLine components never rendered even when the teamRunSnapshot
 * payload carried dependsOn entries (design mode mapped them fine).
 *
 * The live handler must derive the dependency map from the same payload
 * it already consumes: the champ:teamUpdate CustomEvent dispatched by
 * the main.js bridge from `teamRunSnapshot` messages.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/preact";
import {
  AgentGraphPanel,
  teamStateSignal,
} from "../components/AgentGraphPanel";
import type { TeamRunState } from "../types";

function makeState(
  agents: Array<{
    id: string;
    name: string;
    status?: TeamRunState["agents"][number]["status"];
    dependsOn?: string[];
  }>,
): TeamRunState {
  return {
    runId: "run-live",
    teamName: "Live Team",
    userRequest: "Ship it",
    status: "running",
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      status: a.status ?? "done",
      output: "",
      tokenCount: 10,
      validationWarnings: [],
      retryCount: 0,
      ...(a.dependsOn !== undefined ? { dependsOn: a.dependsOn } : {}),
    })) as TeamRunState["agents"],
    sharedMemorySnapshot: {},
    startTime: Date.now(),
    totalTokens: 20,
    filesChanged: [],
    mode: "auto",
  };
}

const mockPostMessage = vi.fn();

describe("AgentGraphPanel live-mode edges", () => {
  beforeEach(() => {
    teamStateSignal.value = null;
    (window as unknown as Record<string, unknown>).vscode = {
      postMessage: mockPostMessage,
    };
    mockPostMessage.mockClear();
  });

  afterEach(() => {
    teamStateSignal.value = null;
    cleanup();
    delete (window as unknown as Record<string, unknown>).vscode;
  });

  function dispatchTeamUpdate(state: TeamRunState): void {
    act(() => {
      window.dispatchEvent(
        new CustomEvent("champ:teamUpdate", {
          detail: { type: "teamRunSnapshot", state },
        }),
      );
    });
  }

  it("renders edge paths when a live snapshot agent declares dependsOn", () => {
    const { container } = render(<AgentGraphPanel />);

    dispatchTeamUpdate(
      makeState([
        { id: "researcher", name: "Researcher" },
        { id: "coder", name: "Coder", dependsOn: ["researcher"] },
      ]),
    );

    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
    // Both agent nodes still render
    expect(container.textContent).toContain("Researcher");
    expect(container.textContent).toContain("Coder");
  });

  it("renders one edge per dependency in a multi-dep graph", () => {
    const { container } = render(<AgentGraphPanel />);

    dispatchTeamUpdate(
      makeState([
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
        { id: "c", name: "Gamma", dependsOn: ["a", "b"] },
      ]),
    );

    expect(container.querySelectorAll("path")).toHaveLength(2);
  });

  it("ignores dependencies referencing unknown agent ids (no crash, no dangling edge)", () => {
    const { container } = render(<AgentGraphPanel />);

    dispatchTeamUpdate(
      makeState([{ id: "solo", name: "Solo", dependsOn: ["ghost"] }]),
    );

    // Node renders; no edge can be drawn to a non-existent position
    expect(container.querySelectorAll("path")).toHaveLength(0);
    expect(container.textContent).toContain("Solo");
  });

  it("renders no edges when the payload carries no dependency info", () => {
    const { container } = render(<AgentGraphPanel />);

    dispatchTeamUpdate(makeState([{ id: "x", name: "Xavier" }]));

    expect(container.querySelectorAll("path")).toHaveLength(0);
  });
});

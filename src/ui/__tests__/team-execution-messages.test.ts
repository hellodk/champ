// src/ui/__tests__/team-execution-messages.test.ts
import { it, expect } from "vitest";
import {
  isTeamPauseRequest,
  isTeamResumeRequest,
  isRerunTeamRequest,
  type TeamCostEstimateMessage,
  type TeamPauseRequest,
  type TeamResumeRequest,
  type RerunTeamRequest,
} from "../messages";

it("TeamCostEstimateMessage has required fields", () => {
  const msg: TeamCostEstimateMessage = {
    type: "teamCostEstimate",
    agentCount: 3,
    estimatedTokens: 9000,
    estimatedCostUsd: "~$0.03",
    teamName: "Test Team",
  };
  expect(msg.agentCount).toBe(3);
});

it("isTeamPauseRequest identifies pause messages", () => {
  expect(isTeamPauseRequest({ type: "teamPause" } as never)).toBe(true);
  expect(isTeamPauseRequest({ type: "teamResume" } as never)).toBe(false);
});

it("isTeamResumeRequest identifies resume messages", () => {
  expect(isTeamResumeRequest({ type: "teamResume" } as never)).toBe(true);
  expect(isTeamResumeRequest({ type: "teamPause" } as never)).toBe(false);
});

it("isRerunTeamRequest identifies rerun messages", () => {
  const msg: RerunTeamRequest = { type: "rerunTeam", runId: "run-123" };
  expect(isRerunTeamRequest(msg as never)).toBe(true);
  expect(isRerunTeamRequest({ type: "teamStop" } as never)).toBe(false);
});

it("TeamPauseRequest has correct type", () => {
  const msg: TeamPauseRequest = { type: "teamPause" };
  expect(msg.type).toBe("teamPause");
});

it("TeamResumeRequest has correct type", () => {
  const msg: TeamResumeRequest = { type: "teamResume" };
  expect(msg.type).toBe("teamResume");
});

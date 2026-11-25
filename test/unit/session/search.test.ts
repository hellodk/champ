import { describe, expect, it } from "vitest";
import { filterSessions } from "@/session/search";

const sessions = [
  {
    id: "sess_alpha",
    label: "Fix parser bug",
    updatedAt: "02 Jun 2026, 16:30:45 IST",
    preview: "Investigate markdown token handling",
  },
  {
    id: "sess_beta",
    label: "Plan release",
    updatedAt: "01 Jun 2026, 09:00:00 IST",
    preview: "Draft checklist for v2.3",
  },
];

describe("shared session search (#192)", () => {
  it("returns all sessions for an empty query", () => {
    expect(filterSessions(sessions, "  ")).toEqual(sessions);
  });

  it("matches id, label and message preview case-insensitively", () => {
    expect(filterSessions(sessions, "ALPHA").map((s) => s.id)).toEqual([
      "sess_alpha",
    ]);
    expect(filterSessions(sessions, "markdown").map((s) => s.id)).toEqual([
      "sess_alpha",
    ]);
    expect(filterSessions(sessions, "release").map((s) => s.id)).toEqual([
      "sess_beta",
    ]);
  });

  it("requires every term and ranks id matches first", () => {
    expect(filterSessions(sessions, "fix parser").map((s) => s.id)).toEqual([
      "sess_alpha",
    ]);
    expect(filterSessions(sessions, "sess parser").map((s) => s.id)).toEqual([
      "sess_alpha",
    ]);
    expect(filterSessions(sessions, "missing")).toEqual([]);
  });
});

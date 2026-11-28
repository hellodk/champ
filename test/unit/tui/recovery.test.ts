import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  emptyRecovery,
  recordRecovery,
  redoRecovery,
  rewindRecovery,
  undoRecovery,
} from "@/tui/recovery";

const snap = (id: string) => ({
  id,
  label: `state ${id}`,
  at: `2026-01-01T00:00:0${id}.000Z`,
});

describe("recovery history", () => {
  it("records snapshots and undoes/redoes them", () => {
    let state = emptyRecovery(snap("0"));
    state = recordRecovery(state, snap("1"));
    state = recordRecovery(state, snap("2"));
    expect(canUndo(state)).toBe(true);
    const undone = undoRecovery(state);
    expect(undone.present.id).toBe("1");
    expect(canRedo(undone)).toBe(true);
    expect(redoRecovery(undone).present.id).toBe("2");
  });

  it("drops the redo branch when a new snapshot is recorded", () => {
    const undone = undoRecovery(
      recordRecovery(emptyRecovery(snap("0")), snap("1")),
    );
    const fresh = recordRecovery(undone, snap("2"));
    expect(canRedo(fresh)).toBe(false);
  });

  it("rewinds to an earlier snapshot and keeps later ones recoverable", () => {
    let state = recordRecovery(
      recordRecovery(emptyRecovery(snap("0")), snap("1")),
      snap("2"),
    );
    const rewound = rewindRecovery(state, "0");
    expect(rewound.present.id).toBe("0");
    expect(canUndo(rewound)).toBe(false);
    expect(rewound.future.map((item) => item.id)).toEqual(["1", "2"]);
  });
});

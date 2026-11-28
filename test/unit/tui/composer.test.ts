import { describe, expect, it } from "vitest";
import {
  composerBackspace,
  composerInsert,
  composerMove,
  composerReplace,
  composerSubmit,
  composerText,
  emptyComposer,
  shouldSubmitOnEnter,
} from "@/tui/composer";

describe("multiline composer", () => {
  it("keeps newlines from pasted text and places the cursor at the end", () => {
    const typed = composerInsert(emptyComposer(), "first\nsecond");
    expect(composerText(typed)).toBe("first\nsecond");
    expect(typed).toMatchObject({ row: 1, col: 6 });
  });

  it("strips control characters but preserves tabs and newlines", () => {
    const typed = composerInsert(emptyComposer(), "a\x00b\tc\nd");
    expect(composerText(typed)).toBe("ab\tc\nd");
  });

  it("backspace at the start of a line joins the previous line", () => {
    let state = composerInsert(emptyComposer(), "ab\ncd");
    state = composerMove(state, "home");
    const joined = composerBackspace(state);
    expect(composerText(joined)).toBe("abcd");
    expect(joined.col).toBe(2);
  });

  it("clamps cursor movement and replaces the draft from an external editor", () => {
    const state = composerInsert(emptyComposer(), "x\nyz");
    expect(composerMove(state, "down")).toMatchObject({ row: 1, col: 2 });
    const twice = composerMove(composerMove(state, "left"), "left");
    expect(twice).toMatchObject({ row: 1, col: 0 });
    expect(composerMove(twice, "left")).toMatchObject({ row: 0, col: 1 });
    const loaded = composerReplace(state, "one\ntwo\nthree");
    expect(composerText(loaded)).toBe("one\ntwo\nthree");
  });

  it("submits only on plain Enter and clears the draft", () => {
    expect(shouldSubmitOnEnter({})).toBe(true);
    expect(shouldSubmitOnEnter({ ctrl: true })).toBe(false);
    expect(shouldSubmitOnEnter({ meta: true })).toBe(false);
    const submitted = composerSubmit(composerInsert(emptyComposer(), "hello"));
    expect(submitted.text).toBe("hello");
    expect(composerText(submitted.state)).toBe("");
  });
});

/**
 * Unit tests for the headless session store — issue #72 (L2).
 *
 * The store is an append-only JSONL log with checkpoint records keyed by
 * sequence, so a resumed session replays to the last checkpoint without
 * re-summarising. These tests pin the on-disk format, the replay/bounding
 * semantics, crash tolerance and the fact that the module is vscode-free.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CorruptSessionLogError, SessionLog } from "@/session/session-log";
import { isValidSessionId } from "@/session/ids";
import type { LLMMessage } from "@/providers/types";

const SESSIONS_DIR = path.join(".champ", "sessions");

function user(text: string): LLMMessage {
  return { role: "user", content: text };
}

function assistant(text: string): LLMMessage {
  return { role: "assistant", content: text };
}

/** Read the raw lines of a session file, without the trailing empty split. */
function lines(workspace: string, id: string): string[] {
  const raw = fs.readFileSync(SessionLog.pathFor(workspace, id), "utf8");
  return raw.split("\n").filter((line) => line.length > 0);
}

describe("SessionLog — creation and on-disk format", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "champ-session-"));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("creates an append-only JSONL log under .champ/sessions", async () => {
    const log = await SessionLog.create(ws, {
      id: "sess-1",
      model: "mock-model",
      mode: "agent",
    });

    expect(log.id).toBe("sess-1");
    expect(log.path).toBe(path.join(ws, SESSIONS_DIR, "sess-1.jsonl"));
    expect(fs.existsSync(log.path)).toBe(true);

    const raw = fs.readFileSync(log.path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    const header = JSON.parse(lines(ws, "sess-1")[0]) as Record<
      string,
      unknown
    >;
    expect(header).toMatchObject({
      v: 1,
      kind: "header",
      id: "sess-1",
      workspace: ws,
      model: "mock-model",
      mode: "agent",
    });
    expect(typeof header.createdAt).toBe("number");
  });

  it("records metadata that survives a reopen", async () => {
    await SessionLog.create(ws, { id: "sess-meta", model: "m", mode: "ask" });
    const reopened = await SessionLog.open(ws, "sess-meta");

    expect(reopened).not.toBeNull();
    expect(reopened!.meta).toMatchObject({
      id: "sess-meta",
      workspace: ws,
      model: "m",
      mode: "ask",
    });
    expect(reopened!.messageCount).toBe(0);
  });

  it("returns null when opening a session that does not exist", async () => {
    expect(await SessionLog.open(ws, "nope")).toBeNull();
  });

  it("refuses to create a session twice", async () => {
    await SessionLog.create(ws, { id: "sess-dup" });
    await expect(SessionLog.create(ws, { id: "sess-dup" })).rejects.toThrow(
      /already exists/i,
    );
  });

  it("rejects ids that could escape the sessions directory", async () => {
    for (const bad of ["../escape", "a/b", "..", ".", "", "sess\u00001"]) {
      expect(isValidSessionId(bad), `id ${JSON.stringify(bad)}`).toBe(false);
      await expect(SessionLog.create(ws, { id: bad })).rejects.toThrow(
        /invalid session id/i,
      );
      await expect(SessionLog.open(ws, bad)).rejects.toThrow(
        /invalid session id/i,
      );
    }
    expect(isValidSessionId("sess-abc_1.2")).toBe(true);
  });
});

describe("SessionLog — append and replay", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "champ-session-"));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("appends one JSONL record per call and replays messages in order", async () => {
    const log = await SessionLog.create(ws, { id: "s" });
    const appended = await log.appendMessages([user("one"), assistant("two")]);

    expect(appended).toBe(2);
    expect(log.messageCount).toBe(2);
    expect(lines(ws, "s")).toHaveLength(2); // header + one messages record

    await log.appendMessages([user("three")]);

    const reopened = await SessionLog.open(ws, "s");
    const replay = reopened!.replay();
    expect(replay.messages).toEqual([
      user("one"),
      assistant("two"),
      user("three"),
    ]);
    expect(replay.recorded).toBe(3);
    expect(replay.elided).toBe(0);
    expect(replay.skippedLines).toBe(0);
    expect(replay.checkpoint).toBeUndefined();
  });

  it("preserves content blocks and tool-call bookkeeping verbatim", async () => {
    const rich: LLMMessage = {
      role: "assistant",
      content: [{ type: "text", text: "thinking" }],
      toolCalls: [
        { id: "call_1", name: "read_file", arguments: { path: "a" } },
      ],
    };
    const result: LLMMessage = {
      role: "tool",
      content: "1: a",
      toolCallId: "call_1",
    };

    const log = await SessionLog.create(ws, { id: "rich" });
    await log.appendMessages([user("go"), rich, result]);

    const reopened = await SessionLog.open(ws, "rich");
    expect(reopened!.replay().messages).toEqual([user("go"), rich, result]);
  });

  it("does not touch the disk when there is nothing to append", async () => {
    const log = await SessionLog.create(ws, { id: "empty" });
    expect(await log.appendMessages([])).toBe(0);
    expect(lines(ws, "empty")).toHaveLength(1);
  });
});

describe("SessionLog — checkpoints bound the replayed context", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "champ-session-"));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("replays only messages after the last checkpoint, without re-summarising", async () => {
    const log = await SessionLog.create(ws, { id: "cp" });
    await log.appendMessages([user("old-1"), assistant("old-2")]);
    const checkpoint = await log.markCheckpoint({
      label: "after setup",
      summary: "The user asked for a refactor.",
    });
    await log.appendMessages([user("new-1"), assistant("new-2")]);

    expect(checkpoint.upTo).toBe(2);
    expect(checkpoint.label).toBe("after setup");

    const reopened = await SessionLog.open(ws, "cp");
    const replay = reopened!.replay();
    expect(replay.messages).toEqual([user("new-1"), assistant("new-2")]);
    expect(replay.recorded).toBe(4);
    expect(replay.elided).toBe(2);
    expect(replay.checkpoint).toMatchObject({
      upTo: 2,
      label: "after setup",
      summary: "The user asked for a refactor.",
    });
  });

  it("uses the latest checkpoint when several are recorded", async () => {
    const log = await SessionLog.create(ws, { id: "cp2" });
    await log.appendMessages([user("a")]);
    await log.markCheckpoint({ label: "first" });
    await log.appendMessages([user("b")]);
    await log.markCheckpoint({ label: "second" });
    await log.appendMessages([user("c")]);

    const reopened = await SessionLog.open(ws, "cp2");
    const replay = reopened!.replay();
    expect(replay.messages).toEqual([user("c")]);
    expect(replay.checkpoint).toMatchObject({ upTo: 2, label: "second" });
    expect(replay.elided).toBe(2);
  });

  it("records a checkpoint without a summary (elision only)", async () => {
    const log = await SessionLog.create(ws, { id: "cp3" });
    await log.appendMessages([user("a"), assistant("b")]);
    await log.markCheckpoint({});

    const replay = (await SessionLog.open(ws, "cp3"))!.replay();
    expect(replay.checkpoint?.summary).toBeUndefined();
    expect(replay.messages).toEqual([]);
    expect(replay.elided).toBe(2);
  });
});

describe("SessionLog — crash tolerance", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "champ-session-"));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("skips a torn trailing line and repairs the tail so appends stay clean", async () => {
    const log = await SessionLog.create(ws, { id: "torn" });
    await log.appendMessages([user("kept")]);

    // Simulate a crash mid-append: a half-written record with no newline.
    fs.appendFileSync(log.path, '{"v":1,"kind":"messages","messa');

    const reopened = await SessionLog.open(ws, "torn");
    const replay = reopened!.replay();
    expect(replay.messages).toEqual([user("kept")]);
    expect(replay.skippedLines).toBe(1);

    // The torn bytes are gone, so the next append is a valid record.
    await reopened!.appendMessages([user("after-crash")]);
    const reopenedAgain = await SessionLog.open(ws, "torn");
    expect(reopenedAgain!.replay().messages).toEqual([
      user("kept"),
      user("after-crash"),
    ]);
    expect(reopenedAgain!.replay().skippedLines).toBe(0);
  });

  it("reports a torn header as corrupt instead of pretending it is absent (review 3)", async () => {
    const log = await SessionLog.create(ws, { id: "torn-header" });
    await log.appendMessages([user("kept")]);

    // Crash while the header was being written: the file exists but its first
    // line is a fragment. `open` must not report "does not exist" — the CLI's
    // open-then-create would then hit EEXIST and the id would fail forever
    // with a contradictory "already exists".
    const raw = fs.readFileSync(log.path, "utf8");
    fs.writeFileSync(log.path, raw.split("\n")[0].slice(0, 12), "utf8");

    await expect(SessionLog.open(ws, "torn-header")).rejects.toThrow(
      CorruptSessionLogError,
    );
    // The message names the file so the CLI can tell the user what to delete.
    await expect(SessionLog.open(ws, "torn-header")).rejects.toThrow(
      /corrupt session log: .*torn-header\.jsonl/,
    );
    // And the file is left for the user to inspect or delete, not rewritten.
    expect(fs.readFileSync(log.path, "utf8")).toBe(
      raw.split("\n")[0].slice(0, 12),
    );
  });

  it("skips corrupt and unknown records instead of failing", async () => {
    const log = await SessionLog.create(ws, { id: "corrupt" });
    await log.appendMessages([user("kept")]);
    fs.appendFileSync(log.path, "not json at all\n");
    fs.appendFileSync(
      log.path,
      `${JSON.stringify({ v: 1, kind: "future-record", payload: 1 })}\n`,
    );
    await log.appendMessages([user("still kept")]);

    const replay = (await SessionLog.open(ws, "corrupt"))!.replay();
    expect(replay.messages).toEqual([user("kept"), user("still kept")]);
    expect(replay.skippedLines).toBe(2);
  });

  it("ignores a stray temp file from an interrupted rewrite", async () => {
    const log = await SessionLog.create(ws, { id: "real" });
    await log.appendMessages([user("hello")]);
    fs.writeFileSync(
      path.join(ws, SESSIONS_DIR, "real.jsonl.tmp"),
      "partial",
      "utf8",
    );

    expect((await SessionLog.list(ws)).map((s) => s.meta.id)).toEqual(["real"]);
  });
});

describe("SessionLog — compaction and listing", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "champ-session-"));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("compacts to the header, the last checkpoint and the surviving messages", async () => {
    const log = await SessionLog.create(ws, { id: "compact" });
    await log.appendMessages([user("dropped-1"), assistant("dropped-2")]);
    await log.markCheckpoint({ label: "keep from here", summary: "old stuff" });
    await log.appendMessages([user("kept-1"), assistant("dropped-3")]);
    await log.markCheckpoint({ label: "final" });
    await log.appendMessages([user("survivor")]);

    // header + 5 records
    expect(lines(ws, "compact")).toHaveLength(6);
    await log.compact();

    const after = lines(ws, "compact").map(
      (line) => JSON.parse(line) as { kind: string; upTo?: number },
    );
    expect(after.map((r) => r.kind)).toEqual([
      "header",
      "checkpoint",
      "messages",
    ]);
    // The surviving checkpoint is rebased onto the compacted log.
    expect(after[1].upTo).toBe(0);
    expect(fs.existsSync(`${log.path}.tmp`)).toBe(false);

    const reopened = await SessionLog.open(ws, "compact");
    const replay = reopened!.replay();
    expect(replay.messages).toEqual([user("survivor")]);
    expect(replay.recorded).toBe(1);
    expect(replay.elided).toBe(0);
    expect(replay.checkpoint).toMatchObject({ upTo: 0, label: "final" });

    // Still appendable after a rewrite.
    await reopened!.appendMessages([assistant("next")]);
    expect((await SessionLog.open(ws, "compact"))!.replay().messages).toEqual([
      user("survivor"),
      assistant("next"),
    ]);
    expect(lines(ws, "compact")).toHaveLength(4);
  });

  it("leaves a log without checkpoints untouched", async () => {
    const log = await SessionLog.create(ws, { id: "nocompact" });
    await log.appendMessages([user("a"), assistant("b")]);
    const before = fs.readFileSync(log.path, "utf8");

    await log.compact();

    expect(fs.readFileSync(log.path, "utf8")).toBe(before);
  });

  it("lists sessions newest first with their message counts", async () => {
    const older = await SessionLog.create(ws, { id: "older" });
    await older.appendMessages([user("a")]);
    // Distinct activity timestamps: sessions are normally minutes apart, but
    // a test creates them in the same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const newer = await SessionLog.create(ws, { id: "newer" });
    await newer.appendMessages([user("a"), assistant("b")]);
    await newer.markCheckpoint({ label: "cp" });
    await newer.appendMessages([user("c")]);

    const listed = await SessionLog.list(ws);
    expect(listed.map((s) => s.meta.id)).toEqual(["newer", "older"]);
    expect(listed[0]).toMatchObject({ messages: 3, checkpoints: 1 });
    expect(listed[1]).toMatchObject({ messages: 1, checkpoints: 0 });
    expect(listed[0].lastActivityAt).toBeGreaterThan(listed[1].lastActivityAt);
  });

  it("returns an empty list for a workspace without sessions", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "champ-session-none-"));
    try {
      expect(await SessionLog.list(empty)).toEqual([]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("never imports vscode", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/session/session-log.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /from\s+["']vscode["']|require\(["']vscode["']\)/,
    );
  });
});

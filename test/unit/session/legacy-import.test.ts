import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { importLegacySession } from "@/session/legacy-import";
import { SessionLog } from "@/session/session-log";

describe("legacy session import", () => {
  let ws: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "champ-import-"));
  });

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("converts a legacy JSON session into a canonical JSONL log", async () => {
    const source = path.join(ws, "old.json");
    await fs.writeFile(
      source,
      JSON.stringify({
        version: 1,
        metadata: { id: "abc", mode: "agent" },
        history: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      }),
    );

    const result = await importLegacySession(ws, source);
    expect(result.id).toBe("legacy-abc");
    expect(result.messages).toBe(2);

    const log = await SessionLog.open(ws, result.id);
    expect(log).not.toBeNull();
    const replay = log!.replay();
    expect(replay.messages.map((m) => m.content)).toEqual(["hello", "hi"]);
    expect(replay.skippedLines).toBe(0);

    // The source document is left untouched.
    expect(JSON.parse(await fs.readFile(source, "utf8"))).toMatchObject({
      metadata: { id: "abc" },
    });
  });

  it("gives repeated imports distinct ids", async () => {
    const source = path.join(ws, "old.json");
    await fs.writeFile(
      source,
      JSON.stringify({ metadata: { id: "x" }, history: [] }),
    );

    const first = await importLegacySession(ws, source);
    const second = await importLegacySession(ws, source);
    expect(first.id).toBe("legacy-x");
    expect(second.id).toBe("legacy-x-2");
  });

  it("rejects malformed legacy documents", async () => {
    const source = path.join(ws, "broken.json");
    await fs.writeFile(source, "{not json");
    await expect(importLegacySession(ws, source)).rejects.toThrow(
      /not valid JSON/,
    );
    await fs.writeFile(source, JSON.stringify({ metadata: {} }));
    await expect(importLegacySession(ws, source)).rejects.toThrow(
      /no history array/,
    );
  });
});

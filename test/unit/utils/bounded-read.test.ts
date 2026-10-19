/**
 * Tests for the bounded read shared by the VS Code and headless `read_file`
 * tools (external review 4b + pass 2).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  MAX_READ_FILE_BYTES,
  countLines,
  prefixReadNote,
  prefixReadRangeError,
  readFilePrefix,
} from "@/utils/bounded-read";

describe("bounded-read", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "champ-bounded-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads at most maxBytes", async () => {
    const file = path.join(dir, "big.txt");
    fs.writeFileSync(file, "x".repeat(1000));

    const prefix = await readFilePrefix(file, 100);

    expect(prefix.length).toBeLessThanOrEqual(100);
    expect(prefix).toBe("x".repeat(100)); // no newline: nothing to cut
  });

  it("cuts the prefix on the last line boundary", async () => {
    const file = path.join(dir, "lines.txt");
    fs.writeFileSync(file, "aaaaaaaaaa\nbbbbbbbbbb\ncccccccccc\n");

    const prefix = await readFilePrefix(file, 25);

    expect(prefix).toBe("aaaaaaaaaa\nbbbbbbbbbb");
  });

  it("cuts at the last newline when the whole file fits", async () => {
    const file = path.join(dir, "small.txt");
    fs.writeFileSync(file, "one\ntwo\n");

    // The trailing newline is the cut point: no empty last line is reported.
    expect(await readFilePrefix(file)).toBe("one\ntwo");
  });

  it("counts lines the way the formatter splits them", () => {
    expect(countLines("one\ntwo\nthree")).toBe(3);
    expect(countLines("single")).toBe(1);
  });

  it("phrases the note for one and for many lines", () => {
    expect(prefixReadNote("a.txt", 3_000_000, 1)).toContain(
      "file is 3000000 bytes; showing the first 1 line]",
    );
    expect(prefixReadNote("a.txt", 3_000_000, 4200)).toContain(
      "showing the first 4200 lines]",
    );
  });

  it("names the file, the size and the route to the rest in the range error", () => {
    const message = prefixReadRangeError("src/big.ts", 9_000_000, 4200, 9000);

    expect(message).toContain("startLine 9000");
    expect(message).toContain("src/big.ts");
    expect(message).toContain("9000000 bytes");
    expect(message).toContain("4200 lines");
    expect(message).toContain("grep_search");
  });

  it("exposes the same cap the tools use", () => {
    expect(MAX_READ_FILE_BYTES).toBe(2_000_000);
  });
});

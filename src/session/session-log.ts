/**
 * Headless session store — append-only JSONL session logs (issue #72, L2).
 *
 * One file per session under `<workspace>/.champ/sessions/<id>.jsonl`, one
 * JSON record per line:
 *
 *   {"v":1,"kind":"header",     "id":…,"createdAt":…,"workspace":…}
 *   {"v":1,"kind":"messages",   "seq":1,"at":…,"messages":[…]}
 *   {"v":1,"kind":"checkpoint", "seq":2,"at":…,"upTo":4,"label":…}
 *
 * Why append-only JSONL instead of rewriting a document per turn (what
 * `SessionStore` does for the VS Code agent manager): a turn appends one
 * record, so a long session never re-serialises its whole history to save a
 * message. A crash between appends can only lose the tail record, which
 * `open` detects and repairs.
 *
 * A `checkpoint` record marks a sequence boundary. On resume, `replay` bounds
 * the context at the newest checkpoint, so pre-checkpoint turns are not sent
 * to the model again — and because any summary computed at checkpoint time is
 * stored in the record, resuming never re-summarises. That bounded replay is
 * what gets prefilled, which is what makes long sessions affordable on a
 * 16 GB machine with a small KV cache.
 */
import * as fs from "fs";
import * as path from "path";
import type { LLMMessage } from "../providers/types";
import { isValidSessionId } from "./ids";

/** Sessions live in the workspace, next to checkpoints (gitignored). */
const SESSIONS_SEGMENTS = [".champ", "sessions"] as const;

const FILE_VERSION = 1;

/** Header metadata: what the session was, and where it ran. */
export interface SessionLogMeta {
  id: string;
  createdAt: number;
  workspace: string;
  model?: string;
  mode?: string;
}

/** A boundary in the log. `upTo` is how many messages precede it. */
export interface SessionCheckpoint {
  /** Record sequence number (1-based, header excluded). */
  seq: number;
  at: number;
  /** Number of messages recorded before the checkpoint. */
  upTo: number;
  label: string;
  /** Summary of the elided messages, if one was recorded. */
  summary?: string;
}

/** `replay()` result: history already bounded by the newest checkpoint. */
export interface SessionReplay {
  meta: SessionLogMeta;
  /** Messages after the newest checkpoint — the context to resume with. */
  messages: LLMMessage[];
  checkpoint?: SessionCheckpoint;
  /** Total messages in the log, bounded or not. */
  recorded: number;
  /** Messages dropped from the replay by the newest checkpoint. */
  elided: number;
  /** Unparseable records encountered while reading the log. */
  skippedLines: number;
}

/** One row of `SessionLog.list()`. */
export interface SessionSummary {
  meta: SessionLogMeta;
  path: string;
  messages: number;
  checkpoints: number;
  lastActivityAt: number;
}

/** Metadata for a new session log. */
export interface NewSession {
  id: string;
  model?: string;
  mode?: string;
  /** Override for deterministic tests; defaults to now. */
  createdAt?: number;
}

interface HeaderRecord {
  v: number;
  kind: "header";
  id: string;
  createdAt: number;
  workspace: string;
  model?: string;
  mode?: string;
}

interface MessagesRecord {
  v: number;
  kind: "messages";
  seq: number;
  at: number;
  messages: LLMMessage[];
}

interface CheckpointRecord extends SessionCheckpoint {
  v: number;
  kind: "checkpoint";
}

interface ParsedLog {
  header?: SessionLogMeta;
  messages: LLMMessage[];
  checkpoints: SessionCheckpoint[];
  lastActivityAt: number;
  /** Records understood so far, header excluded (drives `seq`). */
  records: number;
  /** Records that could not be parsed or understood. */
  skipped: number;
  /** Byte offset just past the last newline-terminated line. */
  goodBytes: number;
  /** Raw text of a valid record on an unterminated last line. */
  rewriteTail: string | null;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function optional<T extends string>(
  key: string,
  value: T | undefined,
): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

/** Atomic write: temp file beside the target, then rename over it. */
async function writeAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, contents, { encoding: "utf8" });
  await fs.promises.rename(tmp, file);
}

/** Fold one parsed record into the reader state; false if not understood. */
function applyRecord(out: ParsedLog, record: Record<string, unknown>): boolean {
  switch (record.kind) {
    case "header": {
      if (out.header) return false;
      if (
        typeof record.id !== "string" ||
        typeof record.createdAt !== "number" ||
        typeof record.workspace !== "string"
      ) {
        return false;
      }
      out.header = {
        id: record.id,
        createdAt: record.createdAt,
        workspace: record.workspace,
        ...optional("model", record.model as string | undefined),
        ...optional("mode", record.mode as string | undefined),
      };
      out.lastActivityAt = record.createdAt;
      return true;
    }
    case "messages": {
      if (!Array.isArray(record.messages)) return false;
      out.messages.push(...(record.messages as LLMMessage[]));
      if (typeof record.at === "number") {
        out.lastActivityAt = Math.max(out.lastActivityAt, record.at);
      }
      return true;
    }
    case "checkpoint": {
      if (typeof record.upTo !== "number" || record.upTo < 0) return false;
      out.checkpoints.push({
        seq:
          typeof record.seq === "number"
            ? record.seq
            : out.checkpoints.length + 1,
        at: typeof record.at === "number" ? record.at : out.lastActivityAt,
        upTo: record.upTo,
        label: typeof record.label === "string" ? record.label : "checkpoint",
        ...optional("summary", record.summary as string | undefined),
      });
      if (typeof record.at === "number") {
        out.lastActivityAt = Math.max(out.lastActivityAt, record.at);
      }
      return true;
    }
    default:
      // Unknown kinds are skipped, so a future format addition cannot make an
      // older reader drop the session.
      return false;
  }
}

/**
 * Read a JSONL log. Never throws on content: unparseable or unknown records
 * are counted as skipped. `goodBytes` marks where a torn tail starts.
 */
function parseLog(raw: string): ParsedLog {
  const out: ParsedLog = {
    messages: [],
    checkpoints: [],
    lastActivityAt: 0,
    records: 0,
    skipped: 0,
    goodBytes: 0,
    rewriteTail: null,
  };

  let offset = 0;
  while (offset < raw.length) {
    const newline = raw.indexOf("\n", offset);
    const terminated = newline !== -1;
    const line = terminated ? raw.slice(offset, newline) : raw.slice(offset);

    if (line.trim().length > 0) {
      let record: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && isRecord(parsed)) {
          record = parsed as Record<string, unknown>;
        }
      } catch {
        record = null;
      }
      if (record && applyRecord(out, record)) {
        // The header is not a numbered record, so `seq` counts past it.
        if (record.kind !== "header") out.records += 1;
        if (!terminated) out.rewriteTail = line;
      } else {
        out.skipped++;
      }
    }

    if (!terminated) break; // torn tail: everything after is suspect
    out.goodBytes = newline + 1;
    offset = newline + 1;
  }

  return out;
}

/** `typeof x === "object"` guard that keeps the linter happy on `unknown`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class SessionLog {
  private constructor(
    readonly id: string,
    readonly path: string,
    readonly meta: SessionLogMeta,
    private messages: LLMMessage[],
    private checkpoints: SessionCheckpoint[],
    private skipped: number,
    /** Records written so far, header excluded — becomes `seq`. */
    private records: number,
  ) {}

  /** Directory holding a workspace's session logs. */
  static dirFor(workspace: string): string {
    return path.join(workspace, ...SESSIONS_SEGMENTS);
  }

  /** Path of a session's JSONL log. */
  static pathFor(workspace: string, id: string): string {
    return path.join(SessionLog.dirFor(workspace), `${id}.jsonl`);
  }

  /**
   * Create a new session log. Fails on an invalid id and on an id already in
   * use, so a resume can never silently truncate an existing history.
   */
  static async create(
    workspace: string,
    init: NewSession,
  ): Promise<SessionLog> {
    if (!isValidSessionId(init.id)) {
      throw new Error(`invalid session id: ${JSON.stringify(init.id)}`);
    }

    await fs.promises.mkdir(SessionLog.dirFor(workspace), { recursive: true });
    const file = SessionLog.pathFor(workspace, init.id);
    const meta: SessionLogMeta = {
      id: init.id,
      createdAt: init.createdAt ?? Date.now(),
      workspace,
      ...optional("model", init.model),
      ...optional("mode", init.mode),
    };
    const log = new SessionLog(init.id, file, meta, [], [], 0, 0);

    try {
      // `wx` creates exclusively: a second create on the same id fails.
      await fs.promises.writeFile(file, jsonLine(headerRecord(meta)), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`session "${init.id}" already exists at ${file}`);
      }
      throw err;
    }
    return log;
  }

  /**
   * Open an existing session log, repairing a torn tail left by a crash.
   * Returns null when the session does not exist or has no readable header.
   */
  static async open(workspace: string, id: string): Promise<SessionLog | null> {
    if (!isValidSessionId(id)) {
      throw new Error(`invalid session id: ${JSON.stringify(id)}`);
    }
    const file = SessionLog.pathFor(workspace, id);

    let raw: string;
    try {
      raw = await fs.promises.readFile(file, "utf8");
    } catch {
      return null;
    }

    const parsed = parseLog(raw);
    if (!parsed.header) return null;

    // A crash mid-append leaves an unterminated line. Drop those bytes so the
    // next append cannot be glued onto a partial record, then restore the
    // record if it was in fact complete.
    if (raw.length > parsed.goodBytes) {
      try {
        await fs.promises.truncate(file, parsed.goodBytes);
        if (parsed.rewriteTail !== null) {
          await fs.promises.appendFile(file, `${parsed.rewriteTail}\n`, "utf8");
        }
      } catch {
        // Read-only filesystem: keep the in-memory view and move on.
      }
    }

    return new SessionLog(
      id,
      file,
      parsed.header,
      parsed.messages,
      parsed.checkpoints,
      parsed.skipped,
      parsed.records,
    );
  }

  /**
   * All sessions in a workspace, most recently active first. Files without a
   * readable header (and non-`.jsonl` entries, such as interrupted rewrites)
   * are ignored rather than failing the listing.
   */
  static async list(workspace: string): Promise<SessionSummary[]> {
    const dir = SessionLog.dirFor(workspace);
    let entries: string[];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const file = path.join(dir, entry);
      let raw: string;
      try {
        raw = await fs.promises.readFile(file, "utf8");
      } catch {
        continue;
      }
      const parsed = parseLog(raw);
      if (!parsed.header) continue;
      summaries.push({
        meta: parsed.header,
        path: file,
        messages: parsed.messages.length,
        checkpoints: parsed.checkpoints.length,
        lastActivityAt: parsed.lastActivityAt,
      });
    }

    summaries.sort(
      (a, b) =>
        b.lastActivityAt - a.lastActivityAt ||
        b.meta.id.localeCompare(a.meta.id),
    );
    return summaries;
  }

  /** Total messages recorded (before checkpoint bounding). */
  get messageCount(): number {
    return this.messages.length;
  }

  /** Newest checkpoint, if the log has one. */
  get checkpoint(): SessionCheckpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  /**
   * Append messages as one JSONL record. One write per turn keeps appends
   * cheap on long sessions; the returned count is how many were stored.
   */
  async appendMessages(messages: LLMMessage[]): Promise<number> {
    if (messages.length === 0) return 0;

    const seq = ++this.records;
    const record: MessagesRecord = {
      v: FILE_VERSION,
      kind: "messages",
      seq,
      at: Date.now(),
      messages,
    };
    await fs.promises.appendFile(this.path, jsonLine(record), "utf8");
    this.messages.push(...messages);
    return messages.length;
  }

  /**
   * Record a checkpoint at the current position. `summary` (when present) is
   * the summary of everything before it, so a resume injects that instead of
   * re-summarising; without one, pre-checkpoint turns are simply elided.
   */
  async markCheckpoint(
    init: { label?: string; summary?: string } = {},
  ): Promise<SessionCheckpoint> {
    const checkpoint: SessionCheckpoint = {
      seq: ++this.records,
      at: Date.now(),
      upTo: this.messages.length,
      label: init.label?.trim() ? init.label.trim() : "checkpoint",
      ...optional("summary", init.summary),
    };
    const record: CheckpointRecord = {
      v: FILE_VERSION,
      kind: "checkpoint",
      ...checkpoint,
    };
    await fs.promises.appendFile(this.path, jsonLine(record), "utf8");
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /**
   * Bounded view of the log: messages after the newest checkpoint, plus that
   * checkpoint (and its summary) so the caller can inject it. Pure in-memory
   * — no model call, no summarisation on resume.
   */
  replay(): SessionReplay {
    const checkpoint = this.checkpoint;
    // Clamp: a checkpoint can never elide more than the log holds, even if the
    // file was edited by hand.
    const upTo = checkpoint
      ? Math.min(checkpoint.upTo, this.messages.length)
      : 0;

    return {
      meta: this.meta,
      messages: this.messages.slice(upTo),
      ...(checkpoint ? { checkpoint } : {}),
      recorded: this.messages.length,
      elided: upTo,
      skippedLines: this.skipped,
    };
  }

  /**
   * Rewrite the log so it only holds the header, the newest checkpoint and
   * the messages after it — bounding disk growth the same way `replay` bounds
   * context. Atomic (temp + rename), so a crash cannot leave a half-log. A log
   * without checkpoints is left untouched.
   */
  async compact(): Promise<void> {
    const checkpoint = this.checkpoint;
    if (!checkpoint) return;

    const survivors = this.messages.slice(
      Math.min(checkpoint.upTo, this.messages.length),
    );
    const rebased: SessionCheckpoint = { ...checkpoint, upTo: 0 };

    const lines = [
      jsonLine(headerRecord(this.meta)),
      jsonLine({
        v: FILE_VERSION,
        kind: "checkpoint",
        ...rebased,
      } satisfies CheckpointRecord),
    ];
    if (survivors.length > 0) {
      const record: MessagesRecord = {
        v: FILE_VERSION,
        kind: "messages",
        seq: 2,
        at: Date.now(),
        messages: survivors,
      };
      lines.push(jsonLine(record));
    }

    await writeAtomic(this.path, lines.join(""));
    this.messages = survivors;
    this.checkpoints = [rebased];
    this.records = lines.length - 1; // header excluded
  }
}

/** Header record for a session's metadata. */
function headerRecord(meta: SessionLogMeta): HeaderRecord {
  return {
    v: FILE_VERSION,
    kind: "header",
    id: meta.id,
    createdAt: meta.createdAt,
    workspace: meta.workspace,
    ...optional("model", meta.model),
    ...optional("mode", meta.mode),
  };
}

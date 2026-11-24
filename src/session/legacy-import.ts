/**
 * Legacy session import adapter.
 *
 * The extension's SessionStore wrote one JSON document per session under
 * `.champ/sessions/*.json`. The canonical CLI store is append-only JSONL.
 * This adapter converts the old format without mutating the source file.
 */
import * as fs from "fs/promises";
import type { LLMMessage } from "../providers/types";
import { isValidSessionId, newSessionId } from "./ids";
import { SessionLog } from "./session-log";

export interface LegacySessionFile {
  version?: number;
  metadata?: { id?: string; mode?: string; label?: string };
  history?: LLMMessage[];
}

export interface LegacyImportResult {
  id: string;
  messages: number;
  path: string;
}

/** Import one legacy JSON session into a new JSONL log. */
export async function importLegacySession(
  workspace: string,
  file: string,
): Promise<LegacyImportResult> {
  const raw = await fs.readFile(file, "utf8");
  let parsed: LegacySessionFile;
  try {
    parsed = JSON.parse(raw) as LegacySessionFile;
  } catch {
    throw new Error(`legacy session is not valid JSON: ${file}`);
  }
  if (!Array.isArray(parsed.history)) {
    throw new Error(`legacy session has no history array: ${file}`);
  }

  const legacyId = parsed.metadata?.id ?? "";
  const candidate = `legacy-${legacyId}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const id = isValidSessionId(candidate) ? candidate : newSessionId();

  let chosenId = id;
  // Re-imports must create a distinct log rather than duplicate messages.
  for (let suffix = 2; await SessionLog.open(workspace, chosenId); suffix++) {
    chosenId = `${id}-${suffix}`;
  }

  const created = await SessionLog.create(workspace, {
    id: chosenId,
    mode: parsed.metadata?.mode,
  });
  await created.appendMessages(parsed.history);
  return {
    id: created.id,
    messages: parsed.history.length,
    path: created.path,
  };
}

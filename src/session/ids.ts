/**
 * Session id rules — shared by the session store and the CLI argument parser
 * (issue #72).
 *
 * Ids become file names under `<workspace>/.champ/sessions`, so they must not
 * contain a path separator or start with a dot: a `--session ../../etc/passwd`
 * must fail here rather than in the filesystem layer.
 */
import * as crypto from "crypto";

/** Allowed session ids: alphanumeric first character, then `._-` as well. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `id` is safe to use as a session file name. */
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/** Fresh session id; the `sess-` prefix makes ids recognisable on sight. */
export function newSessionId(): string {
  return `sess-${crypto.randomUUID()}`;
}

/**
 * Shared session filter/ranking used by the TUI sessions screen and the CLI
 * REPL session list (issue #192). The webview mirrors this algorithm in
 * `webview-ui/static/main.js` because that bundle is plain JavaScript.
 */
export interface SearchableSession {
  id: string;
  label: string;
  updatedAt: string;
  preview?: string;
}

function score(session: SearchableSession, terms: string[]): number {
  const id = session.id.toLowerCase();
  const label = session.label.toLowerCase();
  const preview = (session.preview ?? "").toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (id === term) total += 6;
    else if (id.includes(term)) total += 4;
    if (label.startsWith(term)) total += 3;
    else if (label.includes(term)) total += 2;
    if (preview.includes(term)) total += 1;
  }
  return total;
}

/** Filter sessions by all whitespace-separated terms; rank best matches first. */
export function filterSessions<T extends SearchableSession>(
  sessions: T[],
  query: string,
): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return sessions;
  const scored = sessions
    .map((session) => ({
      session,
      score: score(session, terms),
      haystack: [
        session.id,
        session.label,
        session.updatedAt,
        session.preview ?? "",
      ]
        .join(" ")
        .toLowerCase(),
    }))
    .filter((entry) => terms.every((term) => entry.haystack.includes(term)));
  return scored.sort((a, b) => b.score - a.score).map((entry) => entry.session);
}

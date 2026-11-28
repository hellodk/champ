/** Pure session-tree operations shared by the Sessions screen and reducer. */
import type { TuiSessionSummary } from "./state";

export function renameSession(
  sessions: readonly TuiSessionSummary[],
  id: string,
  label: string,
): TuiSessionSummary[] {
  return sessions.map((session) =>
    session.id === id ? { ...session, label } : session,
  );
}

export function deleteSession(
  sessions: readonly TuiSessionSummary[],
  id: string,
): TuiSessionSummary[] {
  const target = sessions.find((session) => session.id === id);
  const parentId = target?.parentId;
  return sessions
    .filter((session) => session.id !== id)
    .map((session) => {
      if (session.parentId !== id) return session;
      const copy = { ...session };
      delete copy.parentId;
      return parentId === undefined ? copy : { ...copy, parentId };
    });
}

export function forkSession(
  sessions: readonly TuiSessionSummary[],
  id: string,
  newId: string,
  label: string,
): TuiSessionSummary[] {
  if (sessions.some((session) => session.id === newId)) return [...sessions];
  return [
    ...sessions,
    {
      id: newId,
      label,
      parentId: id,
      forkedFrom: id,
      updatedAt: new Date().toISOString(),
    },
  ];
}

export function sessionChildren(
  sessions: readonly TuiSessionSummary[],
  parentId: string | undefined,
): TuiSessionSummary[] {
  return sessions.filter((session) => session.parentId === parentId);
}

export function sessionLineage(
  sessions: readonly TuiSessionSummary[],
  id: string,
): TuiSessionSummary[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const lineage: TuiSessionSummary[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    lineage.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return lineage.reverse();
}

export function moveSessionTab(
  tabs: readonly string[],
  active: number,
  delta: number,
): number {
  if (tabs.length === 0) return 0;
  return (((active + delta) % tabs.length) + tabs.length) % tabs.length;
}

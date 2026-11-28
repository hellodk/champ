/** Undo/redo/rewind history over checkpoint snapshots. */
export interface RecoverySnapshot {
  id: string;
  label: string;
  at: string;
  checkpointId?: string;
}

export interface RecoveryState {
  past: RecoverySnapshot[];
  present: RecoverySnapshot;
  future: RecoverySnapshot[];
}

export function emptyRecovery(snapshot: RecoverySnapshot): RecoveryState {
  return { past: [], present: snapshot, future: [] };
}

export function canUndo(state: RecoveryState): boolean {
  return state.past.length > 0;
}

export function canRedo(state: RecoveryState): boolean {
  return state.future.length > 0;
}

export function recordRecovery(
  state: RecoveryState,
  snapshot: RecoverySnapshot,
): RecoveryState {
  return {
    past: [...state.past, state.present],
    present: snapshot,
    future: [],
  };
}

export function undoRecovery(state: RecoveryState): RecoveryState {
  if (!canUndo(state)) return state;
  const past = [...state.past];
  const present = past.pop()!;
  return { past, present, future: [state.present, ...state.future] };
}

export function redoRecovery(state: RecoveryState): RecoveryState {
  if (!canRedo(state)) return state;
  const [present, ...future] = state.future;
  return { past: [...state.past, state.present], present, future };
}

export function rewindRecovery(
  state: RecoveryState,
  id: string,
): RecoveryState {
  const index = state.past.findIndex((snapshot) => snapshot.id === id);
  if (index === -1) return state;
  return {
    past: state.past.slice(0, index),
    present: state.past[index],
    future: [...state.past.slice(index + 1), state.present, ...state.future],
  };
}

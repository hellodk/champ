/**
 * Pure multiline prompt composer.
 *
 * Keeping cursor movement and paste handling outside the Ink component makes
 * it possible to test editing without a terminal. In particular, pasted
 * newlines are preserved: the previous single-line editor normalised them away.
 */
export interface ComposerState {
  lines: string[];
  row: number;
  col: number;
}

export type ComposerMove = "left" | "right" | "up" | "down" | "home" | "end";

export interface Modifiers {
  ctrl?: boolean;
  meta?: boolean;
}

/** Plain Enter submits; modified Enter inserts a newline instead. */
export function shouldSubmitOnEnter(modifiers: Modifiers): boolean {
  return !modifiers.ctrl && !modifiers.meta;
}

export function emptyComposer(): ComposerState {
  return { lines: [""], row: 0, col: 0 };
}

export function composerText(state: ComposerState): string {
  return state.lines.join("\n");
}

function clean(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // Keep tab (0x09) and newline (0x0A); drop the other control characters.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
  );
}

function offsetOf(state: ComposerState): number {
  let offset = 0;
  for (let index = 0; index < state.row; index += 1) {
    offset += state.lines[index].length + 1;
  }
  return offset + state.col;
}

function stateFrom(text: string, offset: number): ComposerState {
  const lines = text.split("\n");
  let remaining = Math.max(0, Math.min(text.length, offset));
  let row = 0;
  while (row < lines.length - 1 && remaining > lines[row].length) {
    remaining -= lines[row].length + 1;
    row += 1;
  }
  return { lines, row, col: Math.min(remaining, lines[row].length) };
}

export function composerReplace(
  _state: ComposerState,
  text: string,
): ComposerState {
  const cleaned = clean(text);
  return stateFrom(cleaned, cleaned.length);
}

export function composerInsert(
  state: ComposerState,
  text: string,
): ComposerState {
  const inserted = clean(text);
  const current = composerText(state);
  const offset = offsetOf(state);
  return stateFrom(
    `${current.slice(0, offset)}${inserted}${current.slice(offset)}`,
    offset + inserted.length,
  );
}

export function composerBackspace(state: ComposerState): ComposerState {
  if (state.col > 0) {
    const lines = [...state.lines];
    lines[state.row] =
      lines[state.row].slice(0, state.col - 1) +
      lines[state.row].slice(state.col);
    return { lines, row: state.row, col: state.col - 1 };
  }
  if (state.row > 0) {
    const lines = [...state.lines];
    const col = lines[state.row - 1].length;
    lines[state.row - 1] += lines[state.row];
    lines.splice(state.row, 1);
    return { lines, row: state.row - 1, col };
  }
  return state;
}

export function composerDelete(state: ComposerState): ComposerState {
  const line = state.lines[state.row];
  if (state.col < line.length) {
    const lines = [...state.lines];
    lines[state.row] = line.slice(0, state.col) + line.slice(state.col + 1);
    return { lines, row: state.row, col: state.col };
  }
  if (state.row < state.lines.length - 1) {
    const lines = [...state.lines];
    lines[state.row] += lines[state.row + 1];
    lines.splice(state.row + 1, 1);
    return { lines, row: state.row, col: state.col };
  }
  return state;
}

export function composerMove(
  state: ComposerState,
  move: ComposerMove,
): ComposerState {
  const line = state.lines[state.row];
  switch (move) {
    case "home":
      return { ...state, col: 0 };
    case "end":
      return { ...state, col: line.length };
    case "left":
      if (state.col > 0) return { ...state, col: state.col - 1 };
      if (state.row > 0) {
        return {
          ...state,
          row: state.row - 1,
          col: state.lines[state.row - 1].length,
        };
      }
      return state;
    case "right":
      if (state.col < line.length) return { ...state, col: state.col + 1 };
      if (state.row < state.lines.length - 1) {
        return { ...state, row: state.row + 1, col: 0 };
      }
      return state;
    case "up": {
      const row = Math.max(0, state.row - 1);
      return {
        ...state,
        row,
        col: Math.min(state.col, state.lines[row].length),
      };
    }
    case "down": {
      const row = Math.min(state.lines.length - 1, state.row + 1);
      return {
        ...state,
        row,
        col: Math.min(state.col, state.lines[row].length),
      };
    }
    default:
      return state;
  }
}

export function composerSubmit(state: ComposerState): {
  text: string;
  state: ComposerState;
} {
  const text = composerText(state).trim();
  return text === "" ? { text, state } : { text, state: emptyComposer() };
}

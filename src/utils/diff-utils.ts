export interface Hunk {
  /** 0-based line index in old text where this hunk's change starts. */
  changeStartOld: number;
  /** Number of old lines consumed by this change. */
  changeCountOld: number;
  /** Old lines being removed. */
  oldLines: string[];
  /** New lines being inserted. */
  newLines: string[];
}

/**
 * Split two texts into diff hunks using LCS-based diffing.
 * Returns [] if content is identical.
 */
export function splitIntoHunks(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) return [];

  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const edits = computeEdits(oldLines, newLines);

  const hunks: Hunk[] = [];
  let oldPos = 0;
  let i = 0;

  while (i < edits.length) {
    const edit = edits[i];
    if (edit.type === "equal") {
      oldPos++;
      i++;
      continue;
    }

    // Collect contiguous changed block
    const changeStart = oldPos;
    const deletedLines: string[] = [];
    const insertedLines: string[] = [];

    while (i < edits.length && edits[i].type !== "equal") {
      if (edits[i].type === "delete") {
        deletedLines.push(edits[i].line);
        oldPos++;
      } else {
        insertedLines.push(edits[i].line);
      }
      i++;
    }

    hunks.push({
      changeStartOld: changeStart,
      changeCountOld: deletedLines.length,
      oldLines: deletedLines,
      newLines: insertedLines,
    });
  }

  return hunks;
}

/**
 * Apply a subset of hunks to oldText.
 * acceptedIndices: 0-based indices of hunks to apply. Rest are rejected (old lines kept).
 */
export function applyHunks(
  oldText: string,
  hunks: Hunk[],
  acceptedIndices: number[],
): string {
  if (hunks.length === 0) return oldText;

  const accepted = new Set(acceptedIndices);
  const oldLines = oldText.split("\n");
  const result: string[] = [];
  let pos = 0;

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    // Copy old lines up to start of this hunk
    while (pos < hunk.changeStartOld) {
      result.push(oldLines[pos]);
      pos++;
    }

    if (accepted.has(i)) {
      // Accept: use new lines, skip old lines
      result.push(...hunk.newLines);
      pos += hunk.changeCountOld;
    } else {
      // Reject: keep old lines
      for (let k = 0; k < hunk.changeCountOld; k++) {
        if (pos < oldLines.length) result.push(oldLines[pos++]);
      }
    }
  }

  // Copy remaining old lines
  while (pos < oldLines.length) {
    result.push(oldLines[pos++]);
  }

  return result.join("\n");
}

type EditType = "equal" | "insert" | "delete";
interface Edit {
  type: EditType;
  line: string;
}

function computeEdits(a: string[], b: string[]): Edit[] {
  const lcs = longestCommonSubsequence(a, b);
  const edits: Edit[] = [];
  let ia = 0;
  let ib = 0;
  for (const [ai, bi] of lcs) {
    while (ia < ai) {
      edits.push({ type: "delete", line: a[ia++] });
    }
    while (ib < bi) {
      edits.push({ type: "insert", line: b[ib++] });
    }
    edits.push({ type: "equal", line: a[ia++] });
    ib++;
  }
  while (ia < a.length) {
    edits.push({ type: "delete", line: a[ia++] });
  }
  while (ib < b.length) {
    edits.push({ type: "insert", line: b[ib++] });
  }
  return edits;
}

function longestCommonSubsequence(
  a: string[],
  b: string[],
): Array<[number, number]> {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else j--;
  }
  return pairs;
}

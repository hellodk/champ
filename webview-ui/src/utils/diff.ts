// Pure diff logic for the Preact webview bundle.
// No DOM, no VS Code API.

export interface WebviewHunk {
  index: number;
  removedLines: string[];
  addedLines: string[];
  newDocStartLine: number;
}

type EditType = "equal" | "insert" | "delete";
interface RawEdit {
  type: EditType;
  line: string;
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
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      pairs.unshift([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return pairs;
}

function computeRawEdits(a: string[], b: string[]): RawEdit[] {
  const lcs = longestCommonSubsequence(a, b);
  const edits: RawEdit[] = [];
  let ia = 0;
  let ib = 0;
  for (const [ai, bi] of lcs) {
    while (ia < ai) edits.push({ type: "delete", line: a[ia++] });
    while (ib < bi) edits.push({ type: "insert", line: b[ib++] });
    edits.push({ type: "equal", line: a[ia++] });
    ib++;
  }
  while (ia < a.length) edits.push({ type: "delete", line: a[ia++] });
  while (ib < b.length) edits.push({ type: "insert", line: b[ib++] });
  return edits;
}

export function splitHunks(
  oldContent: string,
  newContent: string,
): WebviewHunk[] {
  if (oldContent === newContent) return [];

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const rawEdits = computeRawEdits(oldLines, newLines);

  const hunks: WebviewHunk[] = [];
  let newIdx = 0;
  let editI = 0;

  while (editI < rawEdits.length) {
    const edit = rawEdits[editI];
    if (edit.type === "equal") {
      newIdx++;
      editI++;
      continue;
    }

    const newDocStartLine = newIdx;
    const removedLines: string[] = [];
    const addedLines: string[] = [];

    while (editI < rawEdits.length && rawEdits[editI].type !== "equal") {
      const e = rawEdits[editI];
      if (e.type === "delete") {
        removedLines.push(e.line);
      } else {
        addedLines.push(e.line);
        newIdx++;
      }
      editI++;
    }

    hunks.push({
      index: hunks.length,
      removedLines,
      addedLines,
      newDocStartLine,
    });
  }

  return hunks;
}

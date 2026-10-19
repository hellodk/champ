/**
 * Tool-output budget: keep oversized tool results from eating the context
 * window of a small local model (#114 AC 3).
 *
 * A single `read_file` on a large file, a wide `grep_search`, or a chatty
 * command can return hundreds of kilobytes. Those results are appended to the
 * conversation verbatim, and on a 4B model running in a 16 GB Mac Mini a couple
 * of them overflow the window long before the tool loop's iteration cap is
 * reached — after which nothing the model says is grounded in the request.
 *
 * The elision keeps the head and the tail: the head carries the tool's framing
 * (what was asked for) and the tail carries the end of the output, where errors
 * and summaries usually are. The marker is explicit so the model knows data is
 * missing instead of assuming the output ended where it did.
 */
export const DEFAULT_TOOL_OUTPUT_BUDGET_CHARS = 4000;

/** Fraction of the kept budget given to the head (the rest goes to the tail). */
const HEAD_SHARE = 0.5;

/** The marker inserted where output was elided. */
function markerFor(elided: number): string {
  return `\n… [${elided} chars elided]\n`;
}

/**
 * Truncate `output` to `budget` characters, preserving the head and the tail.
 *
 * Returns `output` untouched when it already fits. The result never exceeds
 * `budget` unless the budget is smaller than the marker itself, in which case
 * the marker (which counts the whole elided output) is returned alone.
 */
export function truncateToolOutput(
  output: string,
  budget: number = DEFAULT_TOOL_OUTPUT_BUDGET_CHARS,
): string {
  if (output.length <= budget) return output;

  // The marker's length depends on `elided`, which depends on the marker's
  // length: settle the fixed point (it moves only when the digit count of
  // `elided` changes, so a pass or two is enough).
  let elided = output.length - budget;
  let result = "";
  for (let pass = 0; pass < 4; pass += 1) {
    const keep = Math.max(0, budget - markerFor(elided).length);
    const head = Math.ceil(keep * HEAD_SHARE);
    const tail = keep - head;
    const nextElided = output.length - head - tail;
    result =
      output.slice(0, head) +
      markerFor(nextElided) +
      (tail > 0 ? output.slice(output.length - tail) : "");
    if (nextElided === elided) break;
    elided = nextElided;
  }
  return result;
}

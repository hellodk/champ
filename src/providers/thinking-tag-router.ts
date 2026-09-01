/**
 * Routing of inline reasoning tags that some models emit inside the
 * ordinary `content` stream (rather than via a dedicated
 * `reasoning_content` / `reasoning` / `reasoning_text` field).
 *
 * Providers that don't expose a separate reasoning field leak their
 * chain-of-thought as tags inside content deltas. The OpenAI-compatible SSE
 * parser surfaces those as ordinary "text" deltas. This router consumes
 * those text deltas chunk-by-chunk and splits each into:
 *   - `reasoning` deltas → shown in the collapsible Thinking UI
 *   - `answer` text      → shown as the normal assistant markdown
 *
 * Reasoning is emitted progressively (each in-thought fragment is returned
 * as soon as it is known to be reasoning) so the Thinking section fills up
 * live while the label reads "Thinking…".
 *
 * Recognised tag pairs (normalised to a single canonical pair):
 *   - ` thinking ... response`
 *   - `<thinking> ... </thinking>`  → normalised to the canonical pair
 *
 * A short carry buffer holds a trailing substring that could be a tag
 * keyword split across chunks (e.g. " thi" | "nking"), so split keywords
 * are still recognised.
 *
 * It is stateful and MUST be fed chunks in order, for a single response.
 * Create a fresh instance per chat() call.
 */
export interface RoutedChunk {
  reasoning: string;
  answer: string;
}

const OPEN = " thinking";
const CLOSE = " response";
// Longest tag keyword (" thinking" / " response") length.
const AMBIGUITY = CLOSE.length;

/**
 * Length of the longest suffix of `s` that is a prefix of either tag
 * keyword — i.e. text that might become a tag once the next chunk arrives.
 */
function partialTagSuffixLen(s: string): number {
  const maxLen = Math.min(AMBIGUITY - 1, s.length);
  for (let n = maxLen; n >= 1; n--) {
    const suffix = s.slice(s.length - n);
    if (OPEN.startsWith(suffix) || CLOSE.startsWith(suffix)) return n;
  }
  return 0;
}

export class ThinkingTagRouter {
  private inTag = false;
  /** Trailing text that might be a split tag keyword, re-examined next push. */
  private carry = "";

  /** Feed one text chunk; returns reasoning/answer fragments to emit. */
  push(chunk: string): RoutedChunk {
    return this.consume(this.carry + chunk);
  }

  /** Call at end of stream: flush any pending carry as answer. */
  end(): RoutedChunk {
    const carry = this.carry;
    this.carry = "";
    if (!carry) return { reasoning: "", answer: "" };
    return this.consume(carry, true);
  }

  private consume(input: string, final = false): RoutedChunk {
    const reasoning: string[] = [];
    const answer: string[] = [];
    let i = 0;
    let carried = 0;

    while (i < input.length) {
      const rest = input.slice(i);
      if (!this.inTag) {
        const openAt = rest.indexOf(OPEN);
        if (openAt < 0) {
          // No opening tag ahead of i. Emit the known answer, carrying only a
          // trailing substring that could be a split keyword.
          if (!final) {
            carried = partialTagSuffixLen(rest);
            if (carried > 0) {
              answer.push(rest.slice(0, rest.length - carried));
              i = input.length;
              break;
            }
          }
          answer.push(rest);
          i = input.length;
          break;
        }
        answer.push(rest.slice(0, openAt));
        i += openAt + OPEN.length;
        this.inTag = true;
        continue;
      }
      // Inside an open  thinking block.
      const closeAt = rest.indexOf(CLOSE);
      if (closeAt < 0) {
        if (!final) {
          carried = partialTagSuffixLen(rest);
          if (carried > 0) {
            reasoning.push(rest.slice(0, rest.length - carried));
            i = input.length;
            break;
          }
        }
        reasoning.push(rest);
        i = input.length;
        break;
      }
      reasoning.push(rest.slice(0, closeAt));
      i += closeAt + CLOSE.length;
      this.inTag = false;
      continue;
    }

    this.carry = carried > 0 ? input.slice(input.length - carried) : "";
    return { reasoning: reasoning.join(""), answer: answer.join("") };
  }
}

/**
 * Context-window resolution helpers.
 *
 * The effective context window for a model is the smallest of three numbers:
 *   - what the user pinned in config (never raise above this),
 *   - what the runtime declares (its served `num_ctx` / context length),
 *   - a sane floor so degenerate 0 values never become "no context".
 *
 * Ticket #119: stop trusting a hardcoded 8192. Prefer the value the server
 * actually runs with, in priority order:
 *   1. runtime `num_ctx` parameter (/api/show `parameters`)
 *   2. runtime `num_ctx` in the modelfile (/api/show `modelfile`)
 *   3. advertised context length in model metadata (model_info `*.context_length`)
 *   4. fallback
 */
export interface ContextWindowMetadata {
  /** Runtime num_ctx from /api/show `parameters` (overrides model_info). */
  numCtxParam?: number;
  /** num_ctx baked into the modelfile (/api/show `modelfile`). */
  numCtxModelfile?: number;
  /** Advertised context length in model metadata (model_info `*.context_length`). */
  modelInfoContextLength?: number;
  /** User/admin ceiling from config — the window is never raised above this. */
  capWindow?: number;
  /** Fallback when nothing is detected. */
  fallback: number;
}

/** Parse a single `num_ctx <n>` line from a raw /api/show string. */
export function parseNumCtxFromGrepLine(line: string): number | undefined {
  const match = /^\s*num_ctx\s+(\d+)/.exec(line);
  return match ? Number(match[1]) : undefined;
}

/** Extract the runtime num_ctx from /api/show `parameters` or `modelfile`. */
export function extractNumCtxFromParameters(raw?: string): number | undefined {
  if (!raw) return undefined;
  for (const line of raw.split("\n")) {
    const parsed = parseNumCtxFromGrepLine(line);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function resolveEffectiveContextWindow(
  meta: ContextWindowMetadata,
): number {
  const runtime =
    meta.numCtxParam ?? meta.numCtxModelfile ?? meta.modelInfoContextLength;

  let effective = runtime && runtime > 0 ? runtime : meta.fallback;
  if (meta.capWindow !== undefined && meta.capWindow > 0) {
    effective = Math.min(effective, meta.capWindow);
  }
  return Math.max(1, effective);
}

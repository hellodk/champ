/**
 * ConditionEvaluator: evaluates simple boolean expressions against a
 * SharedMemory snapshot to decide whether an agent should be skipped.
 *
 * Supported syntax:
 *   <dot.path> != null              — true when value is not null/undefined
 *   <dot.path> == null              — true when value is null/undefined
 *   <dot.path> == true/false        — strict boolean comparison
 *   <dot.path> != true/false        — negated boolean comparison
 *   <dot.path> == "string"          — string equality
 *   <dot.path> != "string"          — string inequality
 *   'substring' in <dot.path>       — true when string value contains substring
 *   'substring' not in <dot.path>   — negation of above
 *
 * Empty expression → always true (no condition = always run).
 *
 * Intentionally minimal: complex logic belongs in the agent's systemPrompt.
 */

export class ConditionEvaluator {
  evaluate(expression: string, memory: Record<string, unknown>): boolean {
    const expr = expression.trim();
    if (!expr) return true;

    // 'substring' in path  /  'substring' not in path
    const inMatch = expr.match(
      /^('[^']*'|"[^"]*")\s+(not\s+in|in)\s+([\w.]+)$/,
    );
    if (inMatch) {
      const [, quotedVal, op, pathStr] = inMatch;
      const needle = quotedVal.slice(1, -1);
      const haystack = String(this.resolvePath(pathStr, memory) ?? "");
      const contains = haystack.includes(needle);
      return op.trim() === "in" ? contains : !contains;
    }

    const match = expr.match(
      /^([\w.]+)\s*(!=|==)\s*(null|true|false|"[^"]*"|'[^']*')$/,
    );
    if (!match) {
      console.warn(
        `ConditionEvaluator: cannot parse expression "${expr}" — defaulting to true`,
      );
      return true;
    }

    const [, pathStr, op, rhsRaw] = match;
    const lhs = this.resolvePath(pathStr, memory);

    let rhs: unknown;
    if (rhsRaw === "null") rhs = null;
    else if (rhsRaw === "true") rhs = true;
    else if (rhsRaw === "false") rhs = false;
    else rhs = rhsRaw.slice(1, -1); // strip quotes

    if (op === "==") {
      if (rhs === null) return lhs === null || lhs === undefined;
      return lhs === rhs;
    } else {
      // !=
      if (rhs === null) return lhs !== null && lhs !== undefined;
      return lhs !== rhs;
    }
  }

  private resolvePath(path: string, obj: Record<string, unknown>): unknown {
    const parts = path.split(".");
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }
}

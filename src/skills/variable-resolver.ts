/**
 * VariableResolver: substitutes {{variable}} placeholders in skill
 * templates with values from the editor + workspace context.
 *
 * Substitution is purely textual — no template engine, no escaping,
 * no conditionals. Unknown placeholders are left intact so the user
 * notices a typo rather than getting silent empty output.
 */

/**
 * Context populated by ChatViewProvider before invoking a skill.
 * Required fields: workspaceRoot, date. All others are optional and
 * resolve to empty string if not set.
 */
export interface SkillContext {
  workspaceRoot: string;
  date: string;
  selection?: string;
  currentFile?: string;
  language?: string;
  userInput?: string;
  cursorLine?: number;
  branch?: string;
}

/**
 * Mapping from placeholder name to context lookup. Order doesn't
 * matter — every placeholder is looked up independently.
 */
const PLACEHOLDER_KEYS = new Set<keyof SkillContext>([
  "workspaceRoot",
  "date",
  "selection",
  "currentFile",
  "language",
  "userInput",
  "cursorLine",
  "branch",
]);

export class VariableResolver {
  /**
   * Replace every `{{name}}` placeholder in `template` with the
   * corresponding value from `context`. Unknown names are left intact.
   * Unset context fields resolve to empty string.
   */
  static resolve(template: string, context: SkillContext): string {
    return template.replace(
      /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g,
      (match, key) => {
        if (!PLACEHOLDER_KEYS.has(key as keyof SkillContext)) {
          // Unknown placeholder — leave as-is so user notices the typo.
          return match;
        }
        const value = context[key as keyof SkillContext];
        if (value === undefined || value === null) return "";
        return String(value);
      },
    );
  }
}

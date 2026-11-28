/**
 * Global command palette: fuzzy matching over screens, slash commands and
 * runtime-provided actions. Prefix suggestions stay in place for users who
 * type `/` directly; the palette is the discovery path for everything else.
 */
import type { CommandSuggestion } from "../cli/commands";
import type { TuiScreen } from "./state";

export interface PaletteAction {
  id: string;
  label: string;
  description: string;
  keywords: string[];
  screen?: TuiScreen;
}

export function buildPaletteActions(
  screens: ReadonlyArray<{ id: TuiScreen; label: string }>,
  slash: ReadonlyArray<CommandSuggestion>,
): PaletteAction[] {
  const actions: PaletteAction[] = screens.map((screen) => ({
    id: `screen:${screen.id}`,
    label: screen.label,
    description: `Open the ${screen.label.toLowerCase()} screen`,
    keywords: [screen.id],
    screen: screen.id,
  }));
  for (const command of slash) {
    actions.push({
      id: `command:${command.name}`,
      label: command.name,
      description: command.description,
      keywords: command.description.toLowerCase().split(/\W+/).filter(Boolean),
    });
  }
  return actions;
}

/** Subsequence score with a bonus at word starts; null means no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") return 0;
  const haystack = text.toLowerCase();
  let cursor = 0;
  let score = 0;
  let streak = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return null;
    streak = found === cursor ? streak + 1 : 1;
    score += 10 + streak * 3 + (found === 0 ? 5 : -2);
    cursor = found + 1;
  }
  return score;
}

export function filterPaletteActions(
  actions: readonly PaletteAction[],
  query: string,
): PaletteAction[] {
  if (query.trim() === "") return [...actions];
  return actions
    .map((action, index) => {
      const labelScore = fuzzyScore(query, action.label);
      const keywordScore = action.keywords.reduce<number | null>(
        (best, keyword) => {
          const score = fuzzyScore(query, keyword);
          if (score === null) return best;
          const adjusted = score - 5;
          return best === null ? adjusted : Math.max(best, adjusted);
        },
        null,
      );
      const scores = [labelScore, keywordScore].filter(
        (score): score is number => score !== null,
      );
      return {
        action,
        index,
        score: scores.length === 0 ? null : Math.max(...scores),
      };
    })
    .filter((entry) => entry.score !== null)
    .sort(
      (left, right) => right.score! - left.score! || left.index - right.index,
    )
    .map((entry) => entry.action);
}

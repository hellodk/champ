/**
 * empty-state-prompts.ts — mode-specific content for the webview empty state.
 *
 * Kept as a typed module so it can be tested and imported by the webview
 * build if one is ever added. For now, the webview inlines a copy via
 * renderEmptyState().
 */

export interface EmptyStatePrompt {
  icon: string;
  label: string;
  /** Pre-filled textarea text when the card is clicked. */
  text: string;
}

/** The three primary modes shown in the webview empty state. */
export type EmptyStateMode = "agent" | "ask" | "plan";

export const EMPTY_STATE_TITLES: Record<EmptyStateMode, string> = {
  agent: "What should I build?",
  ask: "What would you like to know?",
  plan: "What should we plan?",
};

export const EMPTY_STATE_PROMPTS: Record<EmptyStateMode, EmptyStatePrompt[]> = {
  agent: [
    {
      icon: "file-code",
      label: "Explain this file",
      text: "@Code Explain what this code does and how it works.",
    },
    {
      icon: "warning",
      label: "Find bugs",
      text: "Review @Files(src/) for bugs, edge cases, and improvements.",
    },
    {
      icon: "plus",
      label: "Add a feature",
      text: "Add [describe feature] to the codebase with tests.",
    },
    {
      icon: "library",
      label: "Understand codebase",
      text: "@Codebase How is authentication implemented in this project?",
    },
  ],
  ask: [
    {
      icon: "info",
      label: "Explain a concept",
      text: "Explain how [concept] works in plain English.",
    },
    {
      icon: "search",
      label: "Find in codebase",
      text: "@Codebase Where is [feature] implemented?",
    },
    {
      icon: "git-commit",
      label: "Summarize changes",
      text: "@Git Summarize the changes in the last 5 commits.",
    },
    {
      icon: "link-external",
      label: "Lookup docs",
      text: "@Web What are the best practices for [topic]?",
    },
  ],
  plan: [
    {
      icon: "checklist",
      label: "Plan a feature",
      text: "Write a step-by-step implementation plan for [feature].",
    },
    {
      icon: "references",
      label: "Plan a refactor",
      text: "Plan how to refactor @Files(src/) to improve [concern].",
    },
    {
      icon: "beaker",
      label: "Plan test coverage",
      text: "Identify test gaps in @Files(src/) and plan how to fill them.",
    },
    {
      icon: "package",
      label: "Plan a release",
      text: "Create a release checklist for the next version of this project.",
    },
  ],
};

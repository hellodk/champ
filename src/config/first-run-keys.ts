/**
 * first-run-keys.ts — VS Code globalState keys used for onboarding state.
 *
 * Kept in a separate module so tests and extension.ts share the exact
 * same string literals with no risk of typos.
 */

/** Set to `true` once the user completes (or explicitly skips) onboarding. */
export const FIRST_RUN_COMPLETE_KEY = "champ.firstRunComplete";

/**
 * Legacy key written by the old `champ.firstRunDismiss` command.
 * Read on activation for backward compatibility so existing users
 * who already dismissed the wizard are not shown it again.
 */
export const ONBOARDING_DISMISSED_KEY = "champ.onboardingDismissed";

/**
 * Returns true when neither the new nor legacy key is set, meaning the
 * user has never completed or dismissed onboarding.
 *
 * Accepts any Map-like object so it is unit-testable without VS Code mocks.
 */
export function isFirstRunRequired(
  store: { get: (key: string) => boolean | undefined },
): boolean {
  const complete = store.get(FIRST_RUN_COMPLETE_KEY);
  const dismissed = store.get(ONBOARDING_DISMISSED_KEY);
  return !complete && !dismissed;
}

/**
 * Deliberate approval policy for internal validation pipelines.
 *
 * ValidatorAgent runs a bounded list of commands taken from trusted
 * workspace/repo configuration (lint / typecheck / test). Those commands are
 * at the same trust level as the user running them in their own terminal, so
 * prompting per command would break autonomous validation loops without
 * adding safety.
 *
 * This is an EXPLICIT, named policy — not a silent fallback. Generic tool
 * execution keeps deny-by-default (issue #105).
 */
export async function pipelineValidationApproval(
  _description: string,
): Promise<boolean> {
  return true;
}

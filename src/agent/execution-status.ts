/**
 * Shared execution outcome classification.
 *
 * Both the team-agent tool loop and the CLI turn runtime use this so a
 * failed/partial loop can never be reported as a plain success upstream.
 */
export type ExecutionStatus = "success" | "partial" | "failed" | "cancelled";

export interface ExecutionStatusInput {
  error?: string;
  aborted?: boolean;
  text?: string;
  toolFailures?: number;
}

export function executionStatus(input: ExecutionStatusInput): ExecutionStatus {
  if (input.aborted) return "cancelled";
  const hasText = Boolean(input.text?.trim());
  const failedTools = (input.toolFailures ?? 0) > 0;
  if (!input.error && !failedTools) return "success";
  if (hasText) return "partial";
  return "failed";
}

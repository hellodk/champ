/** The only slash commands the headless clients advertise. */
export const CHAT_COMMANDS = [
  "/model",
  "/mode",
  "/status",
  "/index",
  "/export",
  "/clear",
  "/sessions",
  "/session",
  "/checkpoint",
  "/compact",
  "/help",
  "/exit",
] as const;

/** MCP commands stay gated until the MCP lifecycle is safe to reload. */
export const MCP_COMMANDS = ["/mcp status", "/mcp reload"] as const;

export type ChatCommand = (typeof CHAT_COMMANDS)[number];

export function isChatCommand(value: string): value is ChatCommand {
  return (CHAT_COMMANDS as readonly string[]).includes(value.split(/\s+/)[0]);
}

export const CHAT_COMMAND_HELP: Record<ChatCommand, string> = {
  "/model": "show the active model and endpoint registry",
  "/mode": "show or change the agent mode (`/mode agent|ask|plan`)",
  "/status": "show model, mode and session status",
  "/index": "show the semantic index status (alias for `champ index`)",
  "/export": "export redacted provider configuration",
  "/clear": "clear the current screen/transcript",
  "/sessions": "list workspace sessions",
  "/session": "show the current session",
  "/checkpoint": "mark a context checkpoint",
  "/compact": "compact at the newest checkpoint",
  "/help": "show this command list",
  "/exit": "leave Champ",
};

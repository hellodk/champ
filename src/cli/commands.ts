/** The only slash commands the headless clients advertise. */
export const CHAT_COMMANDS = [
  "/model",
  "/mode",
  "/status",
  "/index",
  "/export",
  "/clear",
  "/sessions",
  "/history",
  "/session",
  "/tui",
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

/** Accepted spellings that map onto a canonical command. */
export const CHAT_COMMAND_ALIASES: Record<string, ChatCommand> = {
  "/models": "/model",
};

/** Resolve a command name or alias; returns null for ordinary prompt text. */
export function canonicalChatCommand(value: string): ChatCommand | null {
  const name = value.trim().split(/\s+/)[0];
  if (!name.startsWith("/")) return null;
  const lowered = name.toLowerCase();
  if (isChatCommand(lowered)) return lowered as ChatCommand;
  return CHAT_COMMAND_ALIASES[lowered] ?? null;
}

export interface CommandSuggestion {
  name: string;
  description: string;
}

/**
 * One suggestion list shared by the Ink TUI and the VS Code webview, so both
 * frontends advertise the same commands. Skills are merged in by the callers
 * and de-duplicated against built-ins.
 */
export function commandSuggestions(
  prefix: string,
  skills: CommandSuggestion[] = [],
): CommandSuggestion[] {
  const needle = prefix.trim().toLowerCase().replace(/^\//, "");
  const builtIns: CommandSuggestion[] = [...CHAT_COMMANDS].map((name) => ({
    name,
    description: CHAT_COMMAND_HELP[name],
  }));
  for (const [alias, target] of Object.entries(CHAT_COMMAND_ALIASES)) {
    builtIns.push({
      name: alias,
      description: `alias for ${target}`,
    });
  }
  const seen = new Set<string>();
  const result: CommandSuggestion[] = [];
  for (const item of [...builtIns, ...skills]) {
    if (seen.has(item.name)) continue;
    if (
      needle &&
      !item.name.toLowerCase().replace(/^\//, "").startsWith(needle)
    ) {
      continue;
    }
    seen.add(item.name);
    result.push(item);
  }
  return result;
}

export const CHAT_COMMAND_HELP: Record<ChatCommand, string> = {
  "/model": "show the active model and endpoint registry",
  "/mode": "show or change the agent mode (`/mode agent|ask|plan`)",
  "/status": "show model, mode and session status",
  "/index": "show the semantic index status (alias for `champ index`)",
  "/export": "export redacted provider configuration",
  "/clear": "clear the current screen/transcript",
  "/sessions": "list workspace sessions (`/sessions query --page=2`)",
  "/history": "page through this session (`/history query --page=2`)",
  "/session": "show the current session",
  "/checkpoint": "mark a context checkpoint",
  "/compact": "compact at the newest checkpoint",
  "/help": "show this command list",
  "/tui": "switch to the full-screen interface",
  "/exit": "leave Champ",
};

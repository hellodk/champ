/**
 * Reconstruct structured `TranscriptTurn[]` and `ToolRecord`s when resuming a
 * persisted `SessionLog`, so resumed sessions render with the same grouped
 * collapsible activity UX as live sessions (#212).
 */
import type { LLMMessage } from "../providers/types";
import {
  categorizeTool,
  type ActivityEntry,
  type ActivityGroup,
} from "./activity";
import type { TranscriptTurn, TurnItem } from "./state";
import type { ToolRecord } from "./tool-events";

const PROMPT_TOOL_RESULT_RE =
  /^<tool_result tool="([^"]*)" status="(success|error)">\n([\s\S]*?)<\/tool_result>$/;

function extractText(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

function parsePromptToolResult(
  message: LLMMessage,
): { tool: string; success: boolean; output: string } | null {
  if (message.role !== "user" || typeof message.content !== "string") {
    return null;
  }
  const match = PROMPT_TOOL_RESULT_RE.exec(message.content.trim());
  if (!match) return null;
  return {
    tool: match[1],
    success: match[2] === "success",
    output: match[3],
  };
}

export function reconstructTurnsFromHistory(messages: readonly LLMMessage[]): {
  turns: TranscriptTurn[];
  toolRecords: Record<string, ToolRecord>;
} {
  const turns: TranscriptTurn[] = [];
  const toolRecords: Record<string, ToolRecord> = {};
  let seq = 0;
  const nextId = (prefix: string): string => {
    seq += 1;
    return `resumed-${prefix}-${seq}`;
  };
  const now = new Date().toISOString();

  const ensureTurn = (): TranscriptTurn => {
    if (turns.length === 0) {
      turns.push({
        id: nextId("turn"),
        userMessage: null,
        startedAt: now,
        finishedAt: now,
        items: [],
        status: "completed",
      });
    }
    return turns[turns.length - 1];
  };

  const appendToActivityGroup = (
    turn: TranscriptTurn,
    entry: ActivityEntry,
  ): void => {
    const last = turn.items[turn.items.length - 1];
    if (last?.kind === "activity_group") {
      last.group.entries.push(entry);
      return;
    }
    const group: ActivityGroup = {
      id: nextId("grp"),
      entries: [entry],
    };
    turn.items.push({
      id: nextId("item"),
      kind: "activity_group",
      group,
    });
  };

  const markToolCompleted = (
    toolId: string | undefined,
    toolName: string,
    output: string,
    success: boolean,
  ): void => {
    let resolvedId = toolId;
    if (!resolvedId) {
      // Match the oldest unfinished tool record with the same name (prompt-based replay)
      for (const [id, rec] of Object.entries(toolRecords)) {
        if (rec.start.name === toolName && !rec.result) {
          resolvedId = id;
          break;
        }
      }
    }
    if (!resolvedId) return;
    const existing = toolRecords[resolvedId];
    if (existing) {
      existing.result = {
        id: resolvedId,
        name: existing.start.name,
        output,
        success,
      };
    }
    for (let t = turns.length - 1; t >= 0; t -= 1) {
      for (let i = turns[t].items.length - 1; i >= 0; i -= 1) {
        const item = turns[t].items[i];
        if (item.kind !== "activity_group") continue;
        const match = item.group.entries.find(
          (entry) => entry.kind === "tool" && entry.toolId === resolvedId,
        );
        if (match) {
          match.status = success ? "done" : "failed";
          return;
        }
      }
    }
  };

  for (const message of messages) {
    if (message.role === "system") {
      const text = extractText(message.content).trim();
      if (!text) continue;
      turns.push({
        id: nextId("turn"),
        userMessage: null,
        startedAt: now,
        finishedAt: now,
        items: [{ id: nextId("item"), kind: "notice", text }],
        status: "completed",
      });
      continue;
    }

    if (message.role === "user") {
      const promptTool = parsePromptToolResult(message);
      if (promptTool) {
        markToolCompleted(
          undefined,
          promptTool.tool,
          promptTool.output,
          promptTool.success,
        );
        continue;
      }
      const text = extractText(message.content).trim();
      turns.push({
        id: nextId("turn"),
        userMessage: text,
        startedAt: now,
        finishedAt: now,
        items: [],
        status: "completed",
      });
      continue;
    }

    if (message.role === "tool") {
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type !== "tool_result") continue;
          markToolCompleted(
            block.toolUseId ?? message.toolCallId,
            "tool",
            block.content,
            !block.isError,
          );
        }
      } else if (message.toolCallId) {
        markToolCompleted(message.toolCallId, "tool", message.content, true);
      }
      continue;
    }

    if (message.role === "assistant") {
      const turn = ensureTurn();
      const text = extractText(message.content).trim();
      if (text) {
        const textItem: TurnItem = {
          id: nextId("item"),
          kind: "assistant_text",
          text,
          streaming: false,
        };
        turn.items.push(textItem);
      }

      const calls = [...(message.toolCalls ?? [])];
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_use") {
            calls.push({
              id: block.id,
              name: block.name,
              arguments: block.input,
            });
          }
        }
      }

      for (const call of calls) {
        const id = call.id || nextId("tool");
        const args = JSON.stringify(call.arguments ?? {});
        toolRecords[id] = {
          start: { id, name: call.name, args, startedAt: now },
        };
        appendToActivityGroup(turn, {
          id: nextId("act"),
          kind: "tool",
          category: categorizeTool(call.name),
          toolId: id,
          toolName: call.name,
          startedAt: now,
          finishedAt: now,
          status: "done",
        });
      }
    }
  }

  return { turns, toolRecords };
}

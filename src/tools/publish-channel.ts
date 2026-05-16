/**
 * publish_channel tool: allows an agent with tool access to publish data
 * to a named SharedMemory channel, enabling downstream agents that
 * `subscribes` to that channel to receive the data.
 *
 * Usage in an agent's tool call:
 *   publish_channel({ channel: "research-results", data: { ... } })
 */
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import type { ToolParameterSchema } from "../providers/types";
import type { SharedMemory } from "../agent/agents/types";

export interface PublishChannelArgs {
  channel: string;
  data: unknown;
}

export class PublishChannelTool implements Tool {
  readonly name = "publish_channel";
  readonly description =
    "Publish data to a named channel so that downstream agents subscribed to that channel receive it. " +
    "Use this when you want to pass structured results to agents that declare `subscribes: [channel-name]`.";
  readonly requiresApproval = false;

  readonly parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "The channel name to publish to (e.g. 'research-results').",
      },
      data: {
        type: "object",
        description: "The data payload to publish. Can be any JSON-serialisable value.",
      },
    },
    required: ["channel", "data"],
  };

  constructor(private readonly memory: SharedMemory) {}

  async execute(
    args: Record<string, unknown>,
    _context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const channel = args.channel as string | undefined;
    if (!channel || typeof channel !== "string" || !channel.trim()) {
      return {
        success: false,
        output: 'publish_channel: "channel" must be a non-empty string.',
      };
    }

    const data = args.data;
    this.memory.publish(channel.trim(), data);

    return {
      success: true,
      output: `Published to channel "${channel.trim()}": ${JSON.stringify(data).slice(0, 200)}`,
    };
  }
}

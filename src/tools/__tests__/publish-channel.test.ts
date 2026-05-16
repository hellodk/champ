import { describe, it, expect } from "vitest";
import { PublishChannelTool } from "../publish-channel";
import { SharedMemory } from "../../agent/shared-memory";

function makeContext() {
  return {
    workspaceRoot: "/tmp",
    abortSignal: new AbortController().signal,
    reportProgress: () => {},
    requestApproval: async () => true,
  };
}

describe("PublishChannelTool", () => {
  it("publishes data and returns success", async () => {
    const mem = new SharedMemory();
    const tool = new PublishChannelTool(mem);

    const result = await tool.execute(
      { channel: "results", data: { score: 42 } },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("results");
    expect(mem.hasChannel("results")).toBe(true);
  });

  it("returns failure when channel is missing", async () => {
    const mem = new SharedMemory();
    const tool = new PublishChannelTool(mem);

    const result = await tool.execute({ data: "something" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.output).toContain("channel");
  });

  it("published data is retrievable via subscribe", async () => {
    const mem = new SharedMemory();
    const tool = new PublishChannelTool(mem);

    await tool.execute(
      { channel: "my-channel", data: { key: "value" } },
      makeContext(),
    );

    const data = await mem.subscribe("my-channel", 100);
    expect(data).toEqual({ key: "value" });
  });
});

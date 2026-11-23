import { describe, expect, it } from "vitest";
import { initialTuiState, tuiReducer, type TuiState } from "@/tui/state";

describe("tuiReducer", () => {
  it("cycles screens and keeps chat state intact", () => {
    const first = initialTuiState({
      workspace: "/repo",
      model: "qwen3.5-4b",
      endpoints: [],
    });
    const withMessage = tuiReducer(first, {
      type: "message/add",
      role: "user",
      text: "hello",
    });
    const providers = tuiReducer(withMessage, {
      type: "screen/set",
      screen: "providers",
    });

    expect(providers.screen).toBe("providers");
    expect(providers.messages).toEqual(withMessage.messages);
  });

  it("appends streamed text to the same assistant message", () => {
    const start = initialTuiState({
      workspace: "/repo",
      model: "m",
      endpoints: [],
    });
    const busy = tuiReducer(start, { type: "turn/start" });
    const first = tuiReducer(busy, {
      type: "message/stream",
      role: "assistant",
      text: "Hel",
    });
    const second = tuiReducer(first, {
      type: "message/stream",
      role: "assistant",
      text: "lo",
    });

    expect(second.messages).toHaveLength(2);
    expect(second.messages[0].role).toBe("user");
    expect(second.messages[1].text).toBe("Hello");
    expect(second.messages[1].role).toBe("assistant");
    expect(second.busy).toBe(true);
  });

  it("stores model selection and setup form values", () => {
    const start = initialTuiState({
      workspace: "/repo",
      model: "old",
      endpoints: [
        {
          id: "ep_a",
          name: "Local",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          hasCredential: false,
          models: ["qwen3:8b"],
        },
      ],
    });
    const selected = tuiReducer(start, {
      type: "model/select",
      endpointId: "ep_a",
      model: "qwen3:8b",
    });
    const editing = tuiReducer(selected, {
      type: "setup/change",
      field: "name",
      value: "New endpoint",
    });

    expect(selected.selectedEndpointId).toBe("ep_a");
    expect(selected.selectedModel).toBe("qwen3:8b");
    expect(editing.setup.name).toBe("New endpoint");
  });

  it("validates setup input before allowing save", () => {
    const start = initialTuiState({
      workspace: "/repo",
      model: "m",
      endpoints: [],
    });
    const invalid = tuiReducer(start, { type: "setup/submit" });
    expect(invalid.setup.error).toContain("name");
    expect(invalid.setup.saving).toBe(false);

    const valid = tuiReducer(
      tuiReducer(invalid, {
        type: "setup/change",
        field: "name",
        value: "Local",
      }),
      { type: "setup/submit" },
    );
    expect(valid.setup.error).toBeUndefined();
    expect(valid.setup.saving).toBe(true);
  });
});

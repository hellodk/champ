import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ModelSelectionService } from "@/config/model-selection";
import { EndpointRepository } from "@/config/provider-repository";
import type { ProvidersDocument } from "@/config/provider-model";

describe("ModelSelectionService", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  function makeRepo(): EndpointRepository {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "champ-ms-home-"));
    dirs.push(home);
    return new EndpointRepository({ homeDir: home });
  }

  function makeWorkspace(ref: Record<string, unknown>): string {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "champ-ms-ws-"));
    dirs.push(ws);
    fs.mkdirSync(path.join(ws, ".champ"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".champ", "provider.json"),
      JSON.stringify(ref),
    );
    return ws;
  }

  const baseDoc: ProvidersDocument = {
    version: 1,
    routingMode: "auto",
    endpoints: [
      {
        id: "ep_local",
        name: "Local Ollama",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        credential: null,
        enabled: true,
        isDefault: true,
        supportsTools: true,
        models: [
          {
            id: "qwen2.5-coder:1.5b",
            capabilities: ["coding"],
            contextWindow: 32768,
          },
          {
            id: "nomic-embed-text",
            capabilities: ["embedding"],
            contextWindow: 2048,
          },
        ],
      },
      {
        id: "ep_cloud",
        name: "Cloud Claude",
        provider: "claude",
        credential: { kind: "keyring", id: "ep_cloud" },
        enabled: true,
        isDefault: false,
        supportsTools: true,
        models: [
          {
            id: "claude-sonnet-4-20250514",
            capabilities: ["coding", "general", "tools"],
            contextWindow: 200000,
          },
        ],
      },
    ],
    assignments: {
      default: { endpointId: "ep_local", model: "qwen2.5-coder:1.5b" },
      coding: { endpointId: "ep_cloud", model: "claude-sonnet-4-20250514" },
    },
  };

  it("honors explicit task assignments, embedding discovery in auto mode, and real cloud model defaults", () => {
    const svc = new ModelSelectionService(makeRepo());

    const coding = svc.resolveFromDocument(baseDoc, { task: "coding" });
    expect(coding?.endpoint.id).toBe("ep_cloud");
    expect(coding?.model).toBe("claude-sonnet-4-20250514");
    expect(coding?.source).toBe("assignment");

    const embed = svc.resolveFromDocument(baseDoc, { task: "embedding" });
    expect(embed?.endpoint.id).toBe("ep_local");
    expect(embed?.model).toBe("nomic-embed-text");
    expect(embed?.source).toBe("smart");

    // Large context requirement skips assignment whose model contextWindow is too small
    const huge = svc.resolveFromDocument(
      {
        ...baseDoc,
        assignments: {
          ...baseDoc.assignments,
          coding: { endpointId: "ep_local", model: "qwen2.5-coder:1.5b" },
        },
      },
      {
        task: "coding",
        requiredCapabilities: ["tools"],
        contextTokens: 100000,
      },
    );
    expect(huge?.endpoint.id).toBe("ep_cloud");
    expect(huge?.model).toBe("claude-sonnet-4-20250514");
  });

  it("respects manual routingMode and avoids auto-switching to other endpoints", () => {
    const svc = new ModelSelectionService(makeRepo());
    const manualDoc: ProvidersDocument = {
      ...baseDoc,
      routingMode: "manual",
      assignments: {
        default: { endpointId: "ep_local", model: "qwen2.5-coder:1.5b" },
      },
    };

    const resolved = svc.resolveFromDocument(manualDoc, { task: "embedding" });
    expect(resolved?.endpoint.id).toBe("ep_local");
    expect(resolved?.source).toBe("assignment");
  });

  it("exposes the authoritative routingMode so callers need not re-read the document", () => {
    const svc = new ModelSelectionService(makeRepo());
    expect(
      svc.resolveFromDocument(baseDoc, { task: "default" })?.routingMode,
    ).toBe("auto");
    expect(
      svc.resolveFromDocument(
        { ...baseDoc, routingMode: "manual" },
        { task: "default" },
      )?.routingMode,
    ).toBe("manual");
  });

  it("applies workspace taskModels and fills cloud defaultModel instead of literal default", () => {
    const svc = new ModelSelectionService(makeRepo());
    const ws = makeWorkspace({
      endpoint: "ep_cloud",
      taskModels: { review: "claude-opus-4-20250514" },
    });

    const review = svc.resolveFromDocument(baseDoc, {
      task: "review",
      workspaceDir: ws,
    });
    expect(review?.endpoint.id).toBe("ep_cloud");
    expect(review?.source).toBe("workspace");

    const emptyCloudDoc: ProvidersDocument = {
      version: 1,
      routingMode: "auto",
      endpoints: [
        {
          id: "ep_empty_claude",
          name: "Claude Empty",
          provider: "claude",
          credential: null,
          enabled: true,
          isDefault: true,
          models: [],
        },
      ],
      assignments: {},
    };
    const fallback = svc.resolveFromDocument(emptyCloudDoc, {
      task: "default",
    });
    expect(fallback?.model).toBe("claude-sonnet-4-20250514");
  });
});

/**
 * Integration test for #164: a real, file-backed endpoint registry that has
 * accumulated duplicate rows must present one canonical endpoint in the TUI
 * with the registry-assigned model selected.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { EndpointRegistry } from "@/config/endpoint-registry";
import { EndpointRepository } from "@/config/provider-repository";
import { discoverModels, testEndpoint } from "@/config/model-discovery";
import type { CredentialStore } from "@/config/credential-store";
import type { EndpointSummary } from "@/tui/state";
import { dedupeEndpointSummaries, resolveTuiSelection } from "@/tui/endpoints";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(
    homes
      .splice(0)
      .map((home) => fs.promises.rm(home, { recursive: true, force: true })),
  );
});

function buildRegistry(home: string): EndpointRegistry {
  const repository = new EndpointRepository({ homeDir: home });
  const credentials: CredentialStore = {
    get: async () => undefined,
    set: async () => {},
    delete: async () => {},
  };
  return new EndpointRegistry({
    repository,
    credentials,
    discovery: { discoverModels, testEndpoint },
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

describe("TUI endpoint selection with a real registry (#164)", () => {
  it("shows one canonical row with the assigned model after dedupe", async () => {
    const home = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "champ-164-"),
    );
    homes.push(home);
    const registry = buildRegistry(home);

    const canonical = await registry.add({
      name: "local-llm",
      provider: "openai-compatible",
      baseUrl: "http://192.168.1.64:8030/v1",
      models: [
        { id: "mlx-community/Qwen3.5-4B-MLX-4bit" },
        { id: "mlx-community/Qwen2.5-0.5B-Instruct-4bit" },
      ],
      isDefault: true,
    });
    const duplicate = await registry.add({
      name: "mm",
      provider: "openai-compatible",
      baseUrl: "http://192.168.1.64:8030/v1/",
      models: [{ id: "mlx-community/Qwen3.5-4B-MLX-4bit" }],
    });
    await registry.setAssignment(
      "default",
      duplicate.id,
      "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    );

    const result = await registry.deduplicateByBaseUrl();
    expect(result.removed).toEqual([duplicate.id]);

    const endpoints = await registry.list();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].id).toBe(canonical.id);

    const assignment = await registry.resolveAssignment("default");
    expect(assignment?.endpoint.id).toBe(canonical.id);
    expect(assignment?.model).toBe("mlx-community/Qwen2.5-0.5B-Instruct-4bit");

    const summaries: EndpointSummary[] = endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      provider: endpoint.provider,
      baseUrl: endpoint.baseUrl ?? "",
      hasCredential: false,
      models: endpoint.models.map((model) => model.id),
    }));
    const rows = dedupeEndpointSummaries(summaries, assignment?.endpoint.id);
    expect(rows).toHaveLength(1);

    const selection = resolveTuiSelection(
      rows,
      undefined,
      assignment
        ? { endpointId: assignment.endpoint.id, model: assignment.model }
        : {},
    );
    expect(selection.endpointId).toBe(canonical.id);
    expect(selection.model).toBe("mlx-community/Qwen2.5-0.5B-Instruct-4bit");
    expect(selection.stale).toBe(false);
  });
});

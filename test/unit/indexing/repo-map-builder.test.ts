/**
 * TDD: Tests for RepoMapBuilder.
 *
 * The repo map is a compact tree-sitter-style outline of the workspace
 * (top-level files + symbols, no bodies) injected into the agent's
 * first turn so the model has factual grounding instead of guessing
 * function/class names. Aider's most effective hallucination defense.
 *
 * See docs/HALLUCINATION_MITIGATION.md.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RepoMapBuilder } from "@/indexing/repo-map-builder";
import { ChunkingService } from "@/indexing/chunking-service";

describe("RepoMapBuilder", () => {
  let builder: RepoMapBuilder;

  beforeEach(() => {
    builder = new RepoMapBuilder(new ChunkingService());
  });

  it("should produce an empty map when no files are provided", async () => {
    const map = await builder.buildFromFiles([]);
    expect(map).toBe("");
  });

  it("should list functions and classes from a TypeScript file", async () => {
    const map = await builder.buildFromFiles([
      {
        path: "src/auth/auth-service.ts",
        content: `
export class AuthService {
  private secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  login(email: string, password: string): Promise<User> {
    return fetch('/api/login').then(r => r.json());
  }

  logout(): void {
    this.secret = '';
  }
}

export function helper(): string {
  return 'hi';
}
`,
      },
    ]);

    expect(map).toContain("src/auth/auth-service.ts");
    expect(map).toContain("AuthService");
    expect(map).toContain("helper");
  });

  it("should group symbols under their file path", async () => {
    const map = await builder.buildFromFiles([
      {
        path: "src/a.ts",
        content: `function alpha() {}\nfunction beta() {}`,
      },
      {
        path: "src/b.ts",
        content: `class Charlie {}`,
      },
    ]);

    // Each file appears as a header, with its symbols indented underneath.
    const lines = map.split("\n");
    const aIdx = lines.findIndex((l) => l.includes("src/a.ts"));
    const bIdx = lines.findIndex((l) => l.includes("src/b.ts"));
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);

    // alpha and beta should be between a.ts header and b.ts header.
    const alphaIdx = lines.findIndex((l) => l.includes("alpha"));
    const betaIdx = lines.findIndex((l) => l.includes("beta"));
    expect(alphaIdx).toBeGreaterThan(aIdx);
    expect(alphaIdx).toBeLessThan(bIdx);
    expect(betaIdx).toBeGreaterThan(aIdx);
    expect(betaIdx).toBeLessThan(bIdx);
  });

  it("should skip files that produce no symbols", async () => {
    const map = await builder.buildFromFiles([
      {
        path: "src/empty.ts",
        content: `// just a comment, no symbols`,
      },
      {
        path: "src/has-stuff.ts",
        content: `function foo() {}`,
      },
    ]);

    expect(map).not.toContain("src/empty.ts");
    expect(map).toContain("src/has-stuff.ts");
    expect(map).toContain("foo");
  });

  it("should respect a maximum total size in characters", async () => {
    const bigFiles = Array.from({ length: 200 }, (_, i) => ({
      path: `src/file${i}.ts`,
      content: `function fn${i}() {}\nclass Cls${i} {}`,
    }));

    const map = await builder.buildFromFiles(bigFiles, { maxChars: 2000 });
    expect(map.length).toBeLessThanOrEqual(2200); // some slack for footer
    // The map should mention truncation when it cuts off
    expect(map.toLowerCase()).toContain("truncat");
  });

  it("should not include function bodies", async () => {
    const secret = "this_is_implementation_detail_should_not_be_in_map";
    const map = await builder.buildFromFiles([
      {
        path: "src/foo.ts",
        content: `function foo() { const x = "${secret}"; return x; }`,
      },
    ]);

    expect(map).toContain("foo");
    expect(map).not.toContain(secret);
  });

  it("should produce stable output across calls", async () => {
    const files = [
      { path: "src/a.ts", content: "function alpha() {}" },
      { path: "src/b.ts", content: "function beta() {}" },
    ];
    const map1 = await builder.buildFromFiles(files);
    const map2 = await builder.buildFromFiles(files);
    expect(map1).toBe(map2);
  });

  it("should produce a header that signals what the map is", async () => {
    const map = await builder.buildFromFiles([
      { path: "src/foo.ts", content: "function foo() {}" },
    ]);
    // The map should start with a clear header so the LLM understands
    // what this content represents.
    expect(map.toLowerCase()).toMatch(/repo|workspace|outline|map/);
  });
});

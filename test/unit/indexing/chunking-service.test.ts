/**
 * TDD: Tests for ChunkingService.
 * AST-aware chunking using tree-sitter.
 */
import { describe, it, expect } from "vitest";
import { ChunkingService } from "@/indexing/chunking-service";
import type { CodeChunk } from "@/indexing/chunking-service";

describe("ChunkingService", () => {
  const service = new ChunkingService();

  it("should chunk TypeScript file into functions and classes", async () => {
    const content = `
import { foo } from './bar';

function hello(name: string): string {
  return \`Hello, \${name}!\`;
}

class MyService {
  private value: number;

  constructor(val: number) {
    this.value = val;
  }

  getValue(): number {
    return this.value;
  }
}

export const main = () => hello('world');
`;

    const chunks = await service.chunkFile("test.ts", content);
    expect(chunks.length).toBeGreaterThan(0);

    const functionChunk = chunks.find((c) => c.symbolName === "hello");
    expect(functionChunk).toBeDefined();
    expect(functionChunk!.chunkType).toBe("function");

    const classChunk = chunks.find((c) => c.symbolName === "MyService");
    expect(classChunk).toBeDefined();
    expect(classChunk!.chunkType).toBe("class");
  });

  it("should include line numbers for each chunk", async () => {
    const content = "function a() {}\nfunction b() {}";
    const chunks = await service.chunkFile("test.ts", content);

    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThan(0);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
  });

  it("should fall back to sliding window for unsupported languages", async () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const chunks = await service.chunkFile("data.xyz", content);

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].chunkType).toBe("block");
  });

  it("should split large functions into sub-chunks", async () => {
    const bigFunction = `function huge() {\n${Array.from({ length: 300 }, (_, i) => `  const x${i} = ${i};`).join("\n")}\n}`;
    const chunks = await service.chunkFile("big.ts", bigFunction);

    // Should split into multiple chunks since > 150 lines
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("should handle empty files", async () => {
    const chunks = await service.chunkFile("empty.ts", "");
    expect(chunks).toHaveLength(0);
  });

  it("should include file path in each chunk", async () => {
    const chunks = await service.chunkFile(
      "src/utils.ts",
      "function test() {}",
    );
    for (const chunk of chunks) {
      expect(chunk.filePath).toBe("src/utils.ts");
    }
  });
});

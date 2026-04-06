/**
 * TDD: Tests for FileUploadService.
 * File ingestion: parsing, chunking, session memory.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FileUploadService } from "@/upload/file-upload-service";

describe("FileUploadService", () => {
  let service: FileUploadService;

  beforeEach(() => {
    service = new FileUploadService();
  });

  it("should process a TypeScript file", async () => {
    const result = await service.processFile({
      name: "main.ts",
      content: Buffer.from('export function hello() { return "world"; }'),
      mimeType: "text/typescript",
    });

    expect(result.success).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.fileType).toBe("code");
  });

  it("should process a JSON file", async () => {
    const result = await service.processFile({
      name: "config.json",
      content: Buffer.from('{"key": "value", "nested": {"a": 1}}'),
      mimeType: "application/json",
    });

    expect(result.success).toBe(true);
    expect(result.fileType).toBe("json");
  });

  it("should process a log file", async () => {
    const logContent = Array.from(
      { length: 100 },
      (_, i) =>
        `[2026-04-06T${String(i).padStart(2, "0")}:00:00] INFO: Line ${i}`,
    ).join("\n");

    const result = await service.processFile({
      name: "app.log",
      content: Buffer.from(logContent),
      mimeType: "text/plain",
    });

    expect(result.success).toBe(true);
    expect(result.fileType).toBe("log");
  });

  it("should process a Markdown file", async () => {
    const result = await service.processFile({
      name: "README.md",
      content: Buffer.from(
        "# Hello\n\nThis is a readme.\n\n## Section 2\n\nMore content.",
      ),
      mimeType: "text/markdown",
    });

    expect(result.success).toBe(true);
    expect(result.fileType).toBe("markdown");
  });

  it("should chunk large files to fit token budget", async () => {
    const large = "x".repeat(100000);
    const result = await service.processFile({
      name: "big.txt",
      content: Buffer.from(large),
      mimeType: "text/plain",
    });

    expect(result.success).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(1);
    // Each chunk should be within token budget
    for (const chunk of result.chunks) {
      expect(chunk.length).toBeLessThan(50000);
    }
  });

  it("should store uploaded files in session memory", async () => {
    await service.processFile({
      name: "test.ts",
      content: Buffer.from("const x = 1;"),
      mimeType: "text/typescript",
    });

    const files = service.getSessionFiles();
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("test.ts");
  });

  it("should remove files from session", async () => {
    await service.processFile({
      name: "temp.ts",
      content: Buffer.from("temp"),
      mimeType: "text/typescript",
    });

    service.removeFile("temp.ts");
    expect(service.getSessionFiles()).toHaveLength(0);
  });

  it("should clear all session files", async () => {
    await service.processFile({
      name: "a.ts",
      content: Buffer.from("a"),
      mimeType: "text/typescript",
    });
    await service.processFile({
      name: "b.ts",
      content: Buffer.from("b"),
      mimeType: "text/typescript",
    });

    service.clearSession();
    expect(service.getSessionFiles()).toHaveLength(0);
  });

  it("should reject unsupported binary files", async () => {
    const result = await service.processFile({
      name: "image.png",
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG header
      mimeType: "image/png",
    });

    // Images should still be accepted (for multimodal LLMs) but flagged as image type
    expect(result.fileType).toBe("image");
  });
});

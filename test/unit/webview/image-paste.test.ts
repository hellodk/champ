import { describe, it, expect, beforeEach, vi } from "vitest";

// Pure helper: extract image file from a DataTransfer-like object.
function extractImageFromDataTransfer(
  items: Array<{ type: string; getAsFile: () => File | null }>,
): File | null {
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }
  return null;
}

// Pure helper: read a File as base64 (returns Promise<string>).
async function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<data>" — strip the prefix.
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

describe("extractImageFromDataTransfer", () => {
  it("returns null when items list is empty", () => {
    expect(extractImageFromDataTransfer([])).toBeNull();
  });

  it("returns null when no image item exists", () => {
    const items = [{ type: "text/plain", getAsFile: () => null }];
    expect(extractImageFromDataTransfer(items)).toBeNull();
  });

  it("returns the File for the first image item", () => {
    const mockFile = new File(["data"], "screenshot.png", {
      type: "image/png",
    });
    const items = [
      { type: "text/plain", getAsFile: () => null },
      { type: "image/png", getAsFile: () => mockFile },
    ];
    expect(extractImageFromDataTransfer(items)).toBe(mockFile);
  });

  it("matches image/jpeg", () => {
    const mockFile = new File(["data"], "photo.jpg", { type: "image/jpeg" });
    const items = [{ type: "image/jpeg", getAsFile: () => mockFile }];
    expect(extractImageFromDataTransfer(items)).toBe(mockFile);
  });
});

describe("readFileAsBase64", () => {
  it("resolves with base64 string for a simple file", async () => {
    const file = new File(["hello"], "test.txt", { type: "text/plain" });
    const result = await readFileAsBase64(file);
    // "hello" in base64 is "aGVsbG8="
    expect(result).toBe("aGVsbG8=");
  });
});

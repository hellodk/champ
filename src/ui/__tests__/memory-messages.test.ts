// src/ui/__tests__/memory-messages.test.ts
import { it, expect } from "vitest";
import {
  isOpenMemoryBankRequest,
  isMemoryDeleteRequest,
  isMemoryPinRequest,
  isMemoryAddRequest,
  type MemoryBadgeMessage,
  type MemoryListMessage,
  type MemoryDeleteRequest,
  type MemoryPinRequest,
  type MemoryAddRequest,
} from "../messages";

it("MemoryBadgeMessage has count field", () => {
  const msg: MemoryBadgeMessage = { type: "memoryBadge", count: 5 };
  expect(msg.count).toBe(5);
});

it("MemoryListMessage has items array", () => {
  const msg: MemoryListMessage = { type: "memoryList", items: [] };
  expect(msg.items).toHaveLength(0);
});

it("MemoryDeleteRequest has id field", () => {
  const msg: MemoryDeleteRequest = { type: "memoryDelete", id: "mem-abc" };
  expect(msg.id).toBe("mem-abc");
});

it("MemoryPinRequest has id and pinned fields", () => {
  const msg: MemoryPinRequest = {
    type: "memoryPin",
    id: "mem-abc",
    pinned: true,
  };
  expect(msg.pinned).toBe(true);
});

it("MemoryAddRequest has text field", () => {
  const msg: MemoryAddRequest = {
    type: "memoryAdd",
    text: "Always use Postgres",
  };
  expect(msg.text).toBe("Always use Postgres");
});

it("isOpenMemoryBankRequest identifies correct message type", () => {
  expect(isOpenMemoryBankRequest({ type: "openMemoryBank" } as never)).toBe(
    true,
  );
  expect(
    isOpenMemoryBankRequest({ type: "userMessage", text: "hi" } as never),
  ).toBe(false);
});

it("isMemoryDeleteRequest identifies correct message type", () => {
  expect(
    isMemoryDeleteRequest({ type: "memoryDelete", id: "x" } as never),
  ).toBe(true);
  expect(
    isMemoryDeleteRequest({ type: "userMessage", text: "hi" } as never),
  ).toBe(false);
});

it("isMemoryPinRequest identifies correct message type", () => {
  expect(
    isMemoryPinRequest({ type: "memoryPin", id: "x", pinned: true } as never),
  ).toBe(true);
});

it("isMemoryAddRequest identifies correct message type", () => {
  expect(isMemoryAddRequest({ type: "memoryAdd", text: "hi" } as never)).toBe(
    true,
  );
});

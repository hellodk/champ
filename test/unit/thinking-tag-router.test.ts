import { describe, it, expect } from "vitest";
import { ThinkingTagRouter } from "../../src/providers/thinking-tag-router";

describe("ThinkingTagRouter", () => {
  it("passes through plain text as answer when there are no tags", () => {
    const router = new ThinkingTagRouter();
    expect(router.push("hello world")).toEqual({
      reasoning: "",
      answer: "hello world",
    });
  });

  it("routes a complete <thinking>/</thinking> block to reasoning, rest to answer", () => {
    const router = new ThinkingTagRouter();
    const out = router.push(" thinkingFirst responseThe answer here");
    expect(out.reasoning).toBe("First");
    expect(out.answer).toBe("The answer here");
  });

  it("streams reasoning progressively once the opening tag is seen", () => {
    const router = new ThinkingTagRouter();
    expect(router.push("Hello")).toEqual({ reasoning: "", answer: "Hello" });
    expect(router.push(" thinkingAAA")).toEqual({
      reasoning: "AAA",
      answer: "",
    });
    expect(router.push("BBB")).toEqual({ reasoning: "BBB", answer: "" });
    expect(router.push("CCC responseZZZ")).toEqual({
      reasoning: "CCC",
      answer: "ZZZ",
    });
  });

  it("recognises an opening tag keyword split across chunk boundaries", () => {
    const router = new ThinkingTagRouter();
    const c1 = router.push("X think");
    expect(c1.answer).toBe("X");
    const c2 = router.push("ing.R1R2 responseY");
    expect(c2.reasoning).toBe(".R1R2");
    expect(c2.answer).toBe("Y");
  });

  it("recognises a closing tag keyword split across chunk boundaries", () => {
    const router = new ThinkingTagRouter();
    const c1 = router.push(" thinkingR1 re");
    expect(c1.reasoning).toBe("R1");
    const c2 = router.push("sponseY");
    expect(c2.answer).toBe("Y");
  });

  it("keeps reasoning and answer in separate fragments, never mixed", () => {
    const router = new ThinkingTagRouter();
    const c1 = router.push(" thinkingstep one responseAnswer one");
    expect(c1.reasoning).toBe("step one");
    expect(c1.answer).toBe("Answer one");
    const c2 = router.push(" 2");
    expect(c2.reasoning).toBe("");
    expect(c2.answer).toBe(" 2");
  });

  it("flushes an unclosed trailing thinking block as reasoning on end()", () => {
    const router = new ThinkingTagRouter();
    router.push(" thinkingabc re");
    const out = router.end();
    expect(out.reasoning).toBe(" re");
  });

  it("flushes a deferred plain tail as answer on end()", () => {
    const router = new ThinkingTagRouter();
    router.push("X re");
    const out = router.end();
    expect(out.answer).toBe(" re");
  });

  it("handles an empty chunk gracefully", () => {
    const router = new ThinkingTagRouter();
    expect(router.push("")).toEqual({ reasoning: "", answer: "" });
  });
});

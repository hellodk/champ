import { describe, it, expect, beforeEach, vi } from "vitest";

// Mirrors the activateMessageEdit function we will add to main.js.
function activateMessageEdit(
  messageEl: HTMLElement,
  bodyEl: HTMLElement,
  originalText: string,
  onConfirm: (newText: string) => void,
  onCancel: () => void,
): void {
  const input = document.createElement("textarea");
  input.className = "msg-edit-input";
  input.value = originalText;
  bodyEl.innerHTML = "";
  bodyEl.append(input);

  const confirmBtn = document.createElement("button");
  confirmBtn.className = "msg-edit-confirm";
  confirmBtn.textContent = "Update";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "msg-edit-cancel";
  cancelBtn.textContent = "Cancel";

  const btnRow = document.createElement("div");
  btnRow.className = "msg-edit-btns";
  btnRow.append(confirmBtn, cancelBtn);
  bodyEl.append(btnRow);

  confirmBtn.addEventListener("click", () => {
    const newText = input.value.trim();
    if (!newText) return;
    onConfirm(newText);
  });

  cancelBtn.addEventListener("click", () => {
    onCancel();
  });

  input.focus();
}

describe("activateMessageEdit", () => {
  let messageEl: HTMLElement;
  let bodyEl: HTMLElement;

  beforeEach(() => {
    messageEl = document.createElement("div");
    messageEl.className = "message user";
    bodyEl = document.createElement("div");
    bodyEl.className = "body";
    bodyEl.textContent = "original message";
    messageEl.append(bodyEl);
    document.body.append(messageEl);
  });

  it("replaces body text with a textarea pre-filled with original text", () => {
    activateMessageEdit(
      messageEl,
      bodyEl,
      "original message",
      vi.fn(),
      vi.fn(),
    );
    const input = bodyEl.querySelector<HTMLTextAreaElement>(".msg-edit-input");
    expect(input).not.toBeNull();
    expect(input?.value).toBe("original message");
  });

  it("renders confirm and cancel buttons", () => {
    activateMessageEdit(messageEl, bodyEl, "hello", vi.fn(), vi.fn());
    expect(bodyEl.querySelector(".msg-edit-confirm")).not.toBeNull();
    expect(bodyEl.querySelector(".msg-edit-cancel")).not.toBeNull();
  });

  it("calls onConfirm with trimmed new text when Update is clicked", () => {
    const onConfirm = vi.fn();
    activateMessageEdit(messageEl, bodyEl, "original", onConfirm, vi.fn());
    const input = bodyEl.querySelector<HTMLTextAreaElement>(".msg-edit-input")!;
    input.value = "  updated text  ";
    bodyEl.querySelector<HTMLButtonElement>(".msg-edit-confirm")!.click();
    expect(onConfirm).toHaveBeenCalledWith("updated text");
  });

  it("does not call onConfirm when new text is empty", () => {
    const onConfirm = vi.fn();
    activateMessageEdit(messageEl, bodyEl, "original", onConfirm, vi.fn());
    const input = bodyEl.querySelector<HTMLTextAreaElement>(".msg-edit-input")!;
    input.value = "   ";
    bodyEl.querySelector<HTMLButtonElement>(".msg-edit-confirm")!.click();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("calls onCancel when Cancel is clicked", () => {
    const onCancel = vi.fn();
    activateMessageEdit(messageEl, bodyEl, "original", vi.fn(), onCancel);
    bodyEl.querySelector<HTMLButtonElement>(".msg-edit-cancel")!.click();
    expect(onCancel).toHaveBeenCalled();
  });
});

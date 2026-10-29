import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPendingClipboard, copyInEvent, copySecret } from "./clipboard";
import { useToastStore } from "./stores/toast";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});
afterEach(() => {
  clearPendingClipboard();
  vi.useRealTimers();
});

describe("clipboard", () => {
  it("copies and clears after the configured time", async () => {
    expect(await copySecret("geheim", 30)).toBe(true);
    expect(writeText).toHaveBeenLastCalledWith("geheim");
    const toast = useToastStore().toasts.at(-1);
    expect(toast).toMatchObject({
      key: "clipboard.copiedClears",
      values: { seconds: 30 },
    });
    expect(JSON.stringify(useToastStore().toasts)).not.toContain("geheim");
    await vi.advanceTimersByTimeAsync(29_000);
    expect(writeText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(writeText).toHaveBeenLastCalledWith("");
  });

  it("clears on the next action when the timer may not write", async () => {
    await copySecret("geheim", 5);
    writeText.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(useToastStore().toasts.at(-1)?.key).toBe("clipboard.clearOnAction");
    writeText.mockClear();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(writeText).toHaveBeenCalledWith("");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("does not clear when switched off, and reports failures", async () => {
    await copySecret("x", null);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(writeText).toHaveBeenCalledTimes(1);
    writeText.mockRejectedValueOnce(new Error("denied"));
    expect(await copySecret("y", 30)).toBe(false);
    expect(useToastStore().toasts.at(-1)?.key).toBe("clipboard.failed");
  });

  it("falls back to the next action when clearing on lock is refused", async () => {
    await copySecret("geheim", 30);
    writeText.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    clearPendingClipboard();
    await vi.advanceTimersByTimeAsync(0);
    expect(useToastStore().toasts.at(-1)?.key).toBe("clipboard.clearOnAction");
    // The timer is gone; the next click on the lock screen clears.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writeText).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("pointerdown"));
    expect(writeText).toHaveBeenCalledTimes(3);
    expect(writeText).toHaveBeenLastCalledWith("");

    // Already waiting when the lock comes: a refused write keeps waiting.
    await copySecret("geheim", 5);
    writeText.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    await vi.advanceTimersByTimeAsync(5_000);
    writeText.mockRejectedValueOnce(new DOMException("no", "NotAllowedError"));
    clearPendingClipboard();
    await vi.advanceTimersByTimeAsync(0);
    writeText.mockClear();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(writeText).toHaveBeenCalledWith("");
  });

  it("copies through the copy event and clears pending values on lock", () => {
    const setData = vi.fn();
    const event = new Event("copy", { cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: { setData } });
    copyInEvent(event, "pw", 30);
    expect(setData).toHaveBeenCalledWith("text/plain", "pw");
    expect(event.defaultPrevented).toBe(true);
    clearPendingClipboard();
    expect(writeText).toHaveBeenLastCalledWith("");
    writeText.mockClear();
    clearPendingClipboard();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("clears a copy that a lock overtook while it was written", async () => {
    let written!: () => void;
    writeText.mockReturnValueOnce(
      new Promise<void>((resolve) => (written = resolve)),
    );
    const copying = copySecret("geheim", 30);
    clearPendingClipboard();
    written();
    expect(await copying).toBe(false);
    expect(writeText).toHaveBeenLastCalledWith("");
    // Nothing is left to clear later.
    writeText.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("leaves a copy alone that a lock overtook when clearing is off", async () => {
    let written!: () => void;
    writeText.mockReturnValueOnce(
      new Promise<void>((resolve) => (written = resolve)),
    );
    const copying = copySecret("geheim", null);
    clearPendingClipboard();
    written();
    expect(await copying).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});

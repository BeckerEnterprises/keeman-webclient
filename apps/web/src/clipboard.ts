/**
 * Copying secrets: `writeText` within the user action, `Ctrl+C` via
 * the copy event. After `clipboardClearSeconds` the clipboard is
 * overwritten; where a browser refuses that without a user action
 * (Firefox, Safari), it happens on the next key or click in this tab.
 */
import { useToastStore } from "./stores/toast";

let timer: ReturnType<typeof setTimeout> | undefined;
let waiting = false;

function stopWaiting(): void {
  if (!waiting) return;
  waiting = false;
  window.removeEventListener("pointerdown", clearOnAction, true);
  window.removeEventListener("keydown", clearOnAction, true);
}

/** Within a user action the browsers allow the write. */
function clearOnAction(): void {
  stopWaiting();
  void navigator.clipboard.writeText("").then(
    () => useToastStore().show("clipboard.cleared"),
    () => undefined,
  );
}

/** The write was refused: clear on the next key or click in this tab. */
function clearOnNextAction(): void {
  if (!waiting) {
    waiting = true;
    window.addEventListener("pointerdown", clearOnAction, true);
    window.addEventListener("keydown", clearOnAction, true);
  }
  useToastStore().show("clipboard.clearOnAction", {}, 8000);
}

async function clearNow(): Promise<void> {
  timer = undefined;
  try {
    await navigator.clipboard.writeText("");
    useToastStore().show("clipboard.cleared");
  } catch {
    clearOnNextAction();
  }
}

function schedule(seconds: number | null): void {
  if (timer !== undefined) clearTimeout(timer);
  stopWaiting();
  timer = undefined;
  if (seconds === null) {
    useToastStore().show("clipboard.copied");
    return;
  }
  timer = setTimeout(() => void clearNow(), seconds * 1000);
  useToastStore().show("clipboard.copiedClears", { seconds });
}

/** From a button: one user action, so `writeText` is allowed. */
export async function copySecret(
  text: string,
  clearSeconds: number | null,
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    useToastStore().show("clipboard.failed");
    return false;
  }
  schedule(clearSeconds);
  return true;
}

/** `Ctrl+C`: sets the data of the copy event itself. */
export function copyInEvent(
  event: ClipboardEvent,
  text: string,
  clearSeconds: number | null,
): void {
  if (!event.clipboardData) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", text);
  schedule(clearSeconds);
}

/**
 * On lock and logout: clear what is still pending, as far as allowed.
 * A refused write keeps the next key or click as the fallback, also on
 * the lock or sign-in screen.
 */
export function clearPendingClipboard(): void {
  if (timer === undefined && !waiting) return;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  void navigator.clipboard.writeText("").then(stopWaiting, clearOnNextAction);
}

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dispatchShortcut,
  isTyping,
  registerShortcut,
  shortcutList,
} from "./shortcuts";

const off: (() => void)[] = [];
afterEach(() => {
  for (const remove of off.splice(0)) remove();
  document.body.replaceChildren();
});

function key(init: KeyboardEventInit & { target?: Element }): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  if (init.target)
    Object.defineProperty(event, "target", { value: init.target });
  return event;
}

describe("shortcut dispatcher", () => {
  it("matches keys by event.key with modifiers", () => {
    const lock = vi.fn();
    const search = vi.fn();
    const help = vi.fn();
    off.push(
      registerShortcut({
        scope: "global",
        combos: [{ key: "l", shift: true }],
        label: "x",
        run: lock,
      }),
    );
    off.push(
      registerShortcut({
        scope: "global",
        combos: [{ key: "f", ctrl: true }, { key: "/" }],
        run: search,
      }),
    );
    off.push(
      registerShortcut({ scope: "global", combos: [{ key: "?" }], run: help }),
    );
    dispatchShortcut(key({ key: "L", shiftKey: true }));
    dispatchShortcut(key({ key: "l" }));
    expect(lock).toHaveBeenCalledTimes(1);
    dispatchShortcut(key({ key: "f", metaKey: true }));
    // "/" is Shift+7 on German keyboards: Shift does not matter for it.
    dispatchShortcut(key({ key: "/", shiftKey: true }));
    expect(search).toHaveBeenCalledTimes(2);
    dispatchShortcut(key({ key: "?", shiftKey: true }));
    expect(help).toHaveBeenCalledTimes(1);
    dispatchShortcut(key({ key: "l", shiftKey: true, isComposing: true }));
    dispatchShortcut(key({ key: "l", shiftKey: true, altKey: true }));
    expect(lock).toHaveBeenCalledTimes(1);
    expect(shortcutList()).toHaveLength(1);
  });

  it("lets input fields keep single keys, only Ctrl combinations act", () => {
    const run = vi.fn();
    off.push(
      registerShortcut({
        scope: "global",
        combos: [{ key: "n" }, { key: "Delete" }, { key: "b", ctrl: true }],
        run,
      }),
    );
    const input = document.createElement("input");
    document.body.append(input);
    dispatchShortcut(key({ key: "n", target: input }));
    dispatchShortcut(key({ key: "Delete", target: input }));
    expect(run).not.toHaveBeenCalled();
    dispatchShortcut(key({ key: "b", ctrlKey: true, target: input }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(isTyping(input)).toBe(true);
    expect(isTyping(document.body)).toBe(false);
  });

  it("prefers the focused area and is silent while a dialog is open", () => {
    const tree = vi.fn();
    const main = vi.fn();
    off.push(
      registerShortcut({ scope: "tree", combos: [{ key: "F2" }], run: tree }),
    );
    off.push(
      registerShortcut({ scope: "main", combos: [{ key: "F2" }], run: main }),
    );
    const area = document.createElement("div");
    area.dataset.scope = "tree";
    const row = document.createElement("button");
    area.append(row);
    document.body.append(area);
    row.focus();
    dispatchShortcut(key({ key: "F2" }));
    expect(tree).toHaveBeenCalledTimes(1);
    row.blur();
    dispatchShortcut(key({ key: "F2" }));
    expect(main).toHaveBeenCalledTimes(1);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    dispatchShortcut(key({ key: "F2" }));
    expect(main).toHaveBeenCalledTimes(1);
  });
});

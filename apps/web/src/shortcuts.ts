/**
 * Keyboard shortcuts: one dispatcher, scopes from the focused area
 * (`data-scope`), a registry that also feeds the overview. Single keys only
 * act outside of input fields and never during IME composition.
 */
import { onBeforeUnmount, onMounted } from "vue";

export type Scope = "global" | "tree" | "list" | "detail" | "main";

export interface Combo {
  /** `event.key`; letters in lower case. */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
}

export interface Shortcut {
  scope: Scope;
  combos: Combo[];
  /** i18n key for the overview; hidden without one. */
  label?: string;
  run: (event: KeyboardEvent) => void;
}

const registry = new Set<Shortcut>();

export function registerShortcut(shortcut: Shortcut): () => void {
  registry.add(shortcut);
  return () => registry.delete(shortcut);
}

/** Registers while the component is mounted. */
export function useShortcuts(list: () => Shortcut[]): void {
  const off: (() => void)[] = [];
  onMounted(() => {
    for (const shortcut of list()) off.push(registerShortcut(shortcut));
  });
  onBeforeUnmount(() => {
    for (const remove of off) remove();
  });
}

export function shortcutList(): Shortcut[] {
  return [...registry].filter((s) => s.label !== undefined);
}

export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function matches(combo: Combo, event: KeyboardEvent): boolean {
  const ctrl = event.ctrlKey || event.metaKey;
  if (Boolean(combo.ctrl) !== ctrl || event.altKey) return false;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key !== combo.key) return false;
  // "?" and "/" need Shift on some layouts; letters compare it.
  return /^[a-z]$/.test(combo.key) ||
    combo.key.startsWith("F") ||
    combo.key === "Delete"
    ? Boolean(combo.shift) === event.shiftKey
    : true;
}

/** The scope of the focused element; inside an open dialog nothing else acts. */
function activeScopes(): Scope[] | undefined {
  if (document.querySelector("dialog[open]")) return undefined;
  const element = document.activeElement?.closest("[data-scope]");
  const focused = element?.getAttribute("data-scope") as
    Scope | null | undefined;
  return focused ? [focused, "main", "global"] : ["main", "global"];
}

export function dispatchShortcut(event: KeyboardEvent): void {
  if (event.isComposing || event.defaultPrevented) return;
  const scopes = activeScopes();
  if (!scopes) return;
  // In input fields only combinations with Ctrl act.
  if (isTyping(event.target) && !event.ctrlKey && !event.metaKey) return;
  for (const scope of scopes)
    for (const shortcut of registry)
      if (
        shortcut.scope === scope &&
        shortcut.combos.some((c) => matches(c, event))
      ) {
        event.preventDefault();
        shortcut.run(event);
        return;
      }
}

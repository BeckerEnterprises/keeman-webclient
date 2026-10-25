/**
 * Drag and drop of groups and entries: the dragged objects stay
 * in this module; `dataTransfer` carries only a type without content, so
 * nothing leaks when dropped into another application.
 */
import type { ItemRef } from "@keeman/core";

export const DRAG_TYPE = "application/x-keeman-items";

export interface DragPayload {
  vaultId: string;
  items: ItemRef[];
}

let current: DragPayload | undefined;

export function startDrag(event: DragEvent, payload: DragPayload): void {
  current = payload;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(DRAG_TYPE, "1");
}

/** The payload while one of our drags is over a target. */
export function dragged(event: DragEvent): DragPayload | undefined {
  return event.dataTransfer?.types.includes(DRAG_TYPE) ? current : undefined;
}

export function endDrag(): void {
  current = undefined;
}

export type DropPosition = "before" | "after" | "into";

/** Upper quarter: before, lower quarter: after, otherwise into. */
export function dropPosition(
  event: DragEvent,
  element: Element,
  between: boolean,
): DropPosition {
  if (!between) return "into";
  const box = element.getBoundingClientRect();
  const y = event.clientY - box.top;
  if (y < box.height / 4) return "before";
  if (y > (box.height * 3) / 4) return "after";
  return "into";
}

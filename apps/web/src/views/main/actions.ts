/**
 * What tree, list and detail ask the main view to do: dialogs,
 * writes and their notices live in one place.
 */
import type { ItemRef, MoveTarget } from "@keeman/core";
import { inject, type InjectionKey } from "vue";
import type { DragPayload } from "../../dnd";

export interface MainActions {
  selectGroup(vaultId: string, groupId: string): void;
  openEntry(vaultId: string, entryId: string): void;
  newEntry(vaultId: string, groupId: string): void;
  editEntry(vaultId: string, entryId: string): void;
  newGroup(vaultId: string, parentId: string): void;
  groupProperties(vaultId: string, groupId: string): void;
  renameGroup(vaultId: string, groupId: string, name: string): Promise<boolean>;
  reorderGroup(vaultId: string, groupId: string, direction: -1 | 1): void;
  moveDialog(vaultId: string, items: ItemRef[]): void;
  drop(payload: DragPayload, target: MoveTarget): void;
  remove(vaultId: string, items: ItemRef[], permanent?: boolean): void;
  restore(vaultId: string, items: ItemRef[]): void;
  emptyBin(vaultId: string): void;
  repair(vaultId: string): void;
  /** Copies the resolved value. */
  copy(
    vaultId: string,
    entryId: string,
    what: "password" | "username" | "url",
  ): void;
  /** Opens the resolved URL if its scheme is allowed (`U`). */
  openUrl(vaultId: string, entryId: string): void;
  /** The current TOTP code (`T`). */
  copyTotp(vaultId: string, entryId: string): void;
  databaseSettings(vaultId: string): void;
}

export const ACTIONS: InjectionKey<MainActions> = Symbol("main-actions");

export function useActions(): MainActions {
  const actions = inject(ACTIONS);
  if (!actions) throw new Error("No main view");
  return actions;
}

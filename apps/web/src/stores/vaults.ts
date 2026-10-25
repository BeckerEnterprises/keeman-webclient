/**
 * What the UI shows about the vaults: the read-only projection of the sync
 * engine, stored unchanged (`markRaw`). The engine itself and all
 * keys stay outside Pinia.
 */
import {
  SyncError,
  type NewVaultNames,
  type Notice,
  type SyncEngine,
  type SyncSnapshot,
} from "@keeman/core";
import { defineStore } from "pinia";
import { markRaw } from "vue";

let engine: SyncEngine | undefined;
let unsubscribe: (() => void) | undefined;

export type FirstVault = "idle" | "creating" | "failed";

interface VaultsState {
  snapshot: SyncSnapshot | undefined;
  /** The first vault after the registration. */
  firstVault: FirstVault;
  firstVaultNames: NewVaultNames | undefined;
}

export const useVaultsStore = defineStore("vaults", {
  state: (): VaultsState => ({
    snapshot: undefined,
    firstVault: "idle",
    firstVaultNames: undefined,
  }),
  getters: {
    vaults: (state) => state.snapshot?.vaults ?? [],
  },
  actions: {
    attach(next: SyncEngine): void {
      unsubscribe?.();
      engine = next;
      this.snapshot = markRaw(next.snapshot);
      unsubscribe = next.subscribe((snapshot) => {
        this.snapshot = markRaw(snapshot);
      });
    },

    detach(): void {
      unsubscribe?.();
      unsubscribe = undefined;
      engine = undefined;
      this.snapshot = undefined;
      this.firstVault = "idle";
      this.firstVaultNames = undefined;
    },

    engine(): SyncEngine {
      if (!engine) throw new SyncError("locked");
      return engine;
    },

    /** In the background while the recovery key is shown. */
    async createFirstVault(names: NewVaultNames): Promise<void> {
      this.firstVaultNames = names;
      this.firstVault = "creating";
      try {
        await this.engine().createVault(names);
        this.firstVault = "idle";
      } catch {
        this.firstVault = "failed";
      }
    },

    async retryFirstVault(): Promise<void> {
      if (this.firstVaultNames)
        await this.createFirstVault(this.firstVaultNames);
    },
  },
});

/** Notices of a write as i18n keys with their values. */
export function describeNotices(
  notices: Notice[],
): { key: string; values: Record<string, string> }[] {
  return notices.map((notice) => {
    if (notice.kind === "discarded")
      return {
        key: "notice.discarded",
        values: {
          field: notice.field,
          value:
            typeof notice.value === "string"
              ? notice.value
              : JSON.stringify(notice.value ?? null),
        },
      };
    // Entries: field names only, never values.
    if (notice.kind === "entry_conflict")
      return {
        key: "notice.entry_conflict",
        values: { field: notice.fields.join(", ") },
      };
    const none: Record<string, string> = {};
    return { key: `notice.${notice.kind}`, values: none };
  });
}

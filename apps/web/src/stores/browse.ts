/**
 * State of the main view: layout, tree state, search and the
 * selection in the entry list. Search terms stay in memory only; the
 * layout and the tree state are kept in `keeman.view`.
 */
import type { TreeNode } from "@keeman/core";
import { defineStore } from "pinia";
import { useServices } from "../services";
import { viewState, type TreeState, type ViewLayout } from "../storage";

export type SearchScopeKind = "group" | "vault" | "all";

interface BrowseState {
  layout: ViewLayout;
  trees: Record<string, TreeState>;
  search: { text: string; scope: SearchScopeKind; includeTrash: boolean };
  selection: string[];
  anchor: string | undefined;
}

function userId(): string | undefined {
  try {
    return useServices().account.userId;
  } catch {
    return undefined;
  }
}

export const useBrowseStore = defineStore("browse", {
  state: (): BrowseState => ({
    layout: viewState.layout(),
    trees: {},
    search: { text: "", scope: "vault", includeTrash: false },
    selection: [],
    anchor: undefined,
  }),
  getters: {
    searching: (state) => state.search.text.trim() !== "",
  },
  actions: {
    setLayout(change: Partial<ViewLayout>): void {
      this.layout = { ...this.layout, ...change };
      viewState.saveLayout(this.layout);
    },

    /** Loads the stored tree state of vaults not seen yet. */
    ensureTrees(vaultIds: readonly string[]): void {
      const user = userId();
      if (!user) return;
      const missing = vaultIds.filter((id) => !this.trees[id]);
      if (missing.length === 0) return;
      const trees = { ...this.trees };
      for (const id of missing) trees[id] = viewState.tree(user, id);
      this.trees = trees;
    },

    /** Default: vault node and first level open, everything below closed. */
    isOpen(vaultId: string, node: TreeNode): boolean {
      const state = this.trees[vaultId];
      if (node.depth <= 1) return !(state?.closed.includes(node.id) ?? false);
      return state?.open.includes(node.id) ?? false;
    },

    setOpen(vaultId: string, node: TreeNode, open: boolean): void {
      const state = this.trees[vaultId] ?? { open: [], closed: [] };
      const without = (list: string[]) => list.filter((id) => id !== node.id);
      const next: TreeState = {
        open: without(state.open),
        closed: without(state.closed),
      };
      if (node.depth <= 1 && !open) next.closed.push(node.id);
      if (node.depth > 1 && open) next.open.push(node.id);
      this.trees = { ...this.trees, [vaultId]: next };
      const user = userId();
      if (user) viewState.saveTree(user, vaultId, next);
    },

    select(ids: string[], anchor?: string): void {
      this.selection = ids;
      this.anchor = anchor ?? ids[0];
    },

    clearSearch(): void {
      this.search = { ...this.search, text: "" };
    },

    /** On lock and logout: nothing of the session stays. */
    reset(): void {
      this.trees = {};
      this.search = { text: "", scope: "vault", includeTrash: false };
      this.selection = [];
      this.anchor = undefined;
    },
  },
});

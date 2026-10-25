<script setup lang="ts">
/**
 * The main view: tree, entry list and detail, the search, and the
 * actions with their dialogs. Below 1024 px one area at a time, chosen by
 * the route. IDs are in the path; search terms never.
 */
import {
  SyncError,
  type EntrySummary,
  type IconRef,
  type ItemRef,
  type MoveTarget,
  type Notice,
  type TreeNode,
  type VaultView,
} from "@keeman/core";
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { copyInEvent, copySecret } from "../../clipboard";
import ErrorNotice from "../../components/ErrorNotice.vue";
import WriteNotices from "../../components/WriteNotices.vue";
import EntryDetail from "../../components/detail/EntryDetail.vue";
import ConfirmDialog from "../../components/dialogs/ConfirmDialog.vue";
import GroupDialog from "../../components/dialogs/GroupDialog.vue";
import MoveDialog from "../../components/dialogs/MoveDialog.vue";
import ShortcutsDialog from "../../components/dialogs/ShortcutsDialog.vue";
import EntryEditor from "../../components/editor/EntryEditor.vue";
import EntryList from "../../components/list/EntryList.vue";
import VaultTree from "../../components/tree/VaultTree.vue";
import AppIcon from "../../components/ui/AppIcon";
import type { DragPayload } from "../../dnd";
import { toUiError, type UiError } from "../../errors";
import { openUrl } from "../../open-url";
import { isTyping, useShortcuts, type Shortcut } from "../../shortcuts";
import { useBrowseStore } from "../../stores/browse";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { describeNotices, useVaultsStore } from "../../stores/vaults";
import { ACTIONS, type MainActions } from "./actions";

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const vaults = useVaultsStore();
const browse = useBrowseStore();
const session = useSessionStore();
const toast = useToastStore();

const tree = ref<InstanceType<typeof VaultTree>>();
const list = ref<InstanceType<typeof EntryList>>();
const search = ref<HTMLInputElement>();
const notices = ref<ReturnType<typeof describeNotices>>([]);
const error = ref<UiError>();
const busy = ref(false);

type Dialog =
  | { kind: "group"; vaultId: string; parentId: string; node?: TreeNode }
  | { kind: "move"; vaultId: string; items: ItemRef[] }
  | {
      kind: "across";
      payload: DragPayload;
      target: MoveTarget;
      shared: boolean;
      /** Entries whose references break. */
      refs: number;
    }
  | {
      kind: "delete";
      vaultId: string;
      items: ItemRef[];
      groups: number;
      entries: number;
    }
  | { kind: "emptyBin"; vaultId: string }
  | { kind: "repairEntry"; vaultId: string; entryId: string }
  | { kind: "shortcuts" };
const dialog = ref<Dialog>();

const param = (name: string): string | undefined => {
  const value = route.params[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};
const vaultId = computed(() => param("vaultId"));
const groupId = computed(() => param("groupId"));
const entryId = computed(() => param("entryId"));
const mode = computed(() => route.meta.mode ?? "view");
const vault = computed<VaultView | undefined>(() =>
  vaults.vaults.find((v) => v.id === vaultId.value),
);
const group = computed(() =>
  groupId.value ? vault.value?.tree.nodes.get(groupId.value) : undefined,
);
const depth = computed(() =>
  entryId.value || mode.value === "new"
    ? "detail"
    : groupId.value
      ? "list"
      : "tree",
);

// Without a selection the first database opens, once it is loaded.
watch(
  () =>
    [vaults.snapshot?.loaded, vaultId.value, vaults.vaults[0]?.status] as const,
  async () => {
    if (vaultId.value || !vaults.snapshot?.loaded) return;
    // Narrow screens show the tree first.
    if (window.matchMedia("(max-width: 1023px)").matches) return;
    const first = vaults.vaults[0];
    if (first && first.status !== "loading")
      await router.replace(`/vaults/${first.id}/groups/${first.tree.rootId}`);
  },
  { immediate: true },
);
// A group that is gone (deleted elsewhere, or the stand-in root while
// loading) gives way to the root.
watch(
  () => [vault.value, groupId.value] as const,
  async ([current, id]) => {
    if (!current || !id || current.status === "loading") return;
    if (!current.tree.nodes.has(id))
      await router.replace(
        `/vaults/${current.id}/groups/${current.tree.rootId}`,
      );
  },
);
watch(
  () => vaults.vaults.map((v) => v.id),
  (ids) => {
    browse.ensureTrees(ids);
  },
  { immediate: true },
);
watch(
  locale,
  (value) => {
    if (vaults.snapshot) vaults.engine().setCollation(value);
  },
  { immediate: true },
);

// ------------------------------------------------------------ entries shown

const entries = computed<readonly EntrySummary[]>(() => {
  const current = vault.value;
  if (browse.searching) {
    const scope =
      browse.search.scope === "all" || !current
        ? { kind: "all" as const }
        : browse.search.scope === "group" && groupId.value
          ? {
              kind: "group" as const,
              vaultId: current.id,
              groupId: groupId.value,
            }
          : { kind: "vault" as const, vaultId: current.id };
    // Results follow every new snapshot.
    if (!vaults.snapshot) return [];
    return vaults.engine().search({
      text: browse.search.text,
      scope,
      includeTrash: browse.search.includeTrash,
      searchProtected: session.settings.searchProtectedFields,
    });
  }
  const node = group.value;
  if (!current || !node) return [];
  const ids: string[] = [];
  const add = (id: string) => {
    const n = current.tree.nodes.get(id);
    if (!n) return;
    ids.push(...n.entries);
    if (browse.layout.subgroups) n.children.forEach(add);
  };
  add(node.id);
  return ids
    .map((id) => current.entries.get(id))
    .filter((e): e is EntrySummary => e !== undefined);
});

function pathOf(entry: EntrySummary): string {
  const v = vaults.vaults.find((x) => x.id === entry.vaultId);
  if (!v) return "";
  const names: string[] = [];
  let id: string | null = entry.groupId;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = v.tree.nodes.get(id);
    if (!node) break;
    names.unshift(node.kind === "root" ? (v.name ?? "") : node.name);
    id = node.parentId;
  }
  return names.join(" › ");
}

// ------------------------------------------------------------ writes

async function run(
  task: () => Promise<{ notices: Notice[] } | undefined>,
): Promise<boolean> {
  busy.value = true;
  error.value = undefined;
  notices.value = [];
  try {
    const result = await task();
    if (result) notices.value = describeNotices(result.notices);
    return true;
  } catch (caught) {
    error.value = toUiError(caught);
    return false;
  } finally {
    busy.value = false;
  }
}

function groupPath(v: string, g: string): string {
  return `/vaults/${v}/groups/${g}`;
}

const actions: MainActions = {
  selectGroup(v, g) {
    browse.select([]);
    void router.push(groupPath(v, g));
  },
  openEntry(v, id) {
    const entry = vaults.vaults.find((x) => x.id === v)?.entries.get(id);
    if (entry) void router.push(`${groupPath(v, entry.groupId)}/entries/${id}`);
  },
  newEntry(v, g) {
    void router.push(`${groupPath(v, g)}/new`);
  },
  editEntry(v, id) {
    const entry = vaults.vaults.find((x) => x.id === v)?.entries.get(id);
    if (entry?.writable)
      void router.push(`${groupPath(v, entry.groupId)}/entries/${id}/edit`);
  },
  newGroup(v, parentId) {
    dialog.value = { kind: "group", vaultId: v, parentId };
  },
  groupProperties(v, g) {
    const node = vaults.vaults.find((x) => x.id === v)?.tree.nodes.get(g);
    if (node)
      dialog.value = {
        kind: "group",
        vaultId: v,
        parentId: node.parentId ?? g,
        node,
      };
  },
  renameGroup(v, g, name) {
    return run(() => vaults.engine().renameGroup(v, g, name));
  },
  reorderGroup(v, g, direction) {
    void run(() => vaults.engine().reorderGroup(v, g, direction));
  },
  moveDialog(v, items) {
    dialog.value = { kind: "move", vaultId: v, items };
  },
  drop(payload, target) {
    if (target.vaultId !== payload.vaultId) {
      const shared =
        (vaults.vaults.find((x) => x.id === target.vaultId)?.memberCount ?? 1) >
        1;
      const refs = vaults
        .engine()
        .brokenReferences(payload.vaultId, payload.items);
      dialog.value = { kind: "across", payload, target, shared, refs };
      return;
    }
    void run(() =>
      vaults.engine().move(payload.vaultId, payload.items, target),
    );
  },
  remove(v, items, permanent = false) {
    const engine = vaults.engine();
    const plan = engine.deletePlan(v, items);
    if (plan.mode === "blocked") {
      error.value = toUiError(
        new SyncError(
          plan.reason === "read_only" ? "read_only" : "invalid_target",
        ),
      );
      return;
    }
    if (plan.mode === "trash" && !permanent) {
      void run(async () => {
        const result = await engine.trash(v, items, t("vaults.recycleBin"));
        leaveDeleted(items);
        return result;
      });
      return;
    }
    dialog.value = {
      kind: "delete",
      vaultId: v,
      items,
      groups: plan.groups,
      entries: plan.entries,
    };
  },
  restore(v, items) {
    void run(() => vaults.engine().restore(v, items));
  },
  emptyBin(v) {
    dialog.value = { kind: "emptyBin", vaultId: v };
  },
  repair(v) {
    void run(() =>
      vaults
        .engine()
        .repair(
          v,
          vaults.vaults.find((x) => x.id === v)?.name ?? t("tree.rootName"),
        ),
    );
  },
  copy(v, id, what) {
    const detail = vaults.engine().entry(v, id);
    if (!detail) return;
    let value: string;
    if (what !== "url") value = detail.resolved[what].value;
    else if (!detail.resolved.url) return;
    else if (!detail.resolved.url.ok) {
      toast.show(`url.problem.${detail.resolved.url.error}`);
      return;
    } else value = detail.resolved.url.url;
    void copySecret(value, session.settings.clipboardClearSeconds);
  },
  openUrl(v, id) {
    const url = vaults.engine().entry(v, id)?.resolved.url;
    const refused = url && openUrl(url, session.settings.allowedUrlSchemes);
    if (refused) toast.show(`url.problem.${refused}`);
  },
  copyTotp(v, id) {
    void vaults
      .engine()
      .totp(v, id)
      .then((result) => {
        if (result?.ok === true)
          void copySecret(
            result.value.code,
            session.settings.clipboardClearSeconds,
          );
      });
  },
  databaseSettings(v) {
    void router.push(`/databases/${v}`);
  },
};
provide(ACTIONS, actions);

/** After deleting the shown entry or group, show its parent. */
function leaveDeleted(items: ItemRef[]): void {
  if (!vaultId.value) return;
  if (
    entryId.value &&
    items.some((i) => i.id === entryId.value) &&
    groupId.value
  )
    void router.replace(groupPath(vaultId.value, groupId.value));
  else if (groupId.value && items.some((i) => i.id === groupId.value))
    void router.replace(
      groupPath(vaultId.value, vault.value?.tree.rootId ?? groupId.value),
    );
}

async function saveGroup(props: {
  name: string;
  icon: IconRef | null;
  defaultEntryIcon: IconRef | null;
  notes: string;
}): Promise<void> {
  const current = dialog.value;
  if (current?.kind !== "group") return;
  const ok = await run(async () => {
    if (current.node)
      return vaults
        .engine()
        .updateGroup(current.vaultId, current.node.id, props);
    const result = await vaults
      .engine()
      .createGroup(current.vaultId, current.parentId, props);
    browse.setOpen(
      current.vaultId,
      vault.value?.tree.nodes.get(current.parentId) ??
        ({ id: current.parentId, depth: 2 } as TreeNode),
      true,
    );
    return result;
  });
  if (ok) dialog.value = undefined;
}

async function acknowledgeRollback(): Promise<void> {
  const id = vaultId.value;
  if (id)
    await run(async () => {
      await vaults.engine().acknowledgeRollback(id);
      return undefined;
    });
}

async function confirmMove(target: MoveTarget): Promise<void> {
  const current = dialog.value;
  if (current?.kind !== "move") return;
  dialog.value = undefined;
  if (target.vaultId !== current.vaultId) {
    const shared =
      (vaults.vaults.find((x) => x.id === target.vaultId)?.memberCount ?? 1) >
      1;
    dialog.value = {
      kind: "across",
      payload: { vaultId: current.vaultId, items: current.items },
      target,
      shared,
      refs: vaults.engine().brokenReferences(current.vaultId, current.items),
    };
    return;
  }
  await run(() => vaults.engine().move(current.vaultId, current.items, target));
}

async function confirmAcross(): Promise<void> {
  const current = dialog.value;
  if (current?.kind !== "across") return;
  dialog.value = undefined;
  const ok = await run(() =>
    vaults
      .engine()
      .move(current.payload.vaultId, current.payload.items, current.target),
  );
  if (ok) leaveDeleted(current.payload.items);
}

async function confirmDelete(): Promise<void> {
  const current = dialog.value;
  if (current?.kind !== "delete") return;
  dialog.value = undefined;
  const ok = await run(() =>
    vaults.engine().destroy(current.vaultId, current.items),
  );
  if (ok) leaveDeleted(current.items);
}

async function confirmEmptyBin(): Promise<void> {
  const current = dialog.value;
  if (current?.kind !== "emptyBin") return;
  dialog.value = undefined;
  await run(() => vaults.engine().emptyRecycleBin(current.vaultId));
}

async function confirmRepairEntry(): Promise<void> {
  const current = dialog.value;
  if (current?.kind !== "repairEntry") return;
  dialog.value = undefined;
  await run(() =>
    vaults.engine().repairEntry(current.vaultId, current.entryId),
  );
}

async function editorSaved(id: string, saved: Notice[]): Promise<void> {
  notices.value = describeNotices(saved);
  error.value = undefined;
  if (!vaultId.value || !groupId.value) return;
  // New entries land in the group of the editor; edited ones stay where they are.
  await router.push(
    id
      ? `${groupPath(vaultId.value, groupId.value)}/entries/${id}`
      : groupPath(vaultId.value, groupId.value),
  );
}

async function editorCancel(): Promise<void> {
  if (!vaultId.value || !groupId.value) return;
  await router.push(
    entryId.value
      ? `${groupPath(vaultId.value, groupId.value)}/entries/${entryId.value}`
      : groupPath(vaultId.value, groupId.value),
  );
}

// ------------------------------------------------------------ keyboard

/** Entries the list acts on: the selection, else the shown entry. */
function targets(): ItemRef[] {
  const ids =
    browse.selection.length > 0
      ? browse.selection
      : entryId.value
        ? [entryId.value]
        : [];
  return ids.map((id) => ({ kind: "entry" as const, id }));
}

function current(): EntrySummary | undefined {
  const id = entryId.value ?? browse.selection[0];
  return id ? vault.value?.entries.get(id) : undefined;
}

function focusArea(step: 1 | -1): void {
  const areas = ["tree", "list", "detail"];
  const now =
    document.activeElement
      ?.closest("[data-scope]")
      ?.getAttribute("data-scope") ?? "";
  const index = areas.indexOf(now);
  const next = areas[(index + step + areas.length) % areas.length];
  if (next === "tree") tree.value?.focusSelected();
  else if (next === "list") list.value?.focus();
  else
    document
      .querySelector<HTMLElement>(
        "[data-scope=detail] button, [data-scope=detail] input",
      )
      ?.focus();
}

useShortcuts((): Shortcut[] => [
  {
    scope: "main",
    combos: [{ key: "f", ctrl: true }, { key: "/" }],
    label: "shortcuts.search",
    run: () => search.value?.focus(),
  },
  {
    scope: "main",
    combos: [{ key: "F6" }],
    label: "shortcuts.area",
    run: () => {
      focusArea(1);
    },
  },
  {
    scope: "main",
    combos: [{ key: "F6", shift: true }],
    run: () => {
      focusArea(-1);
    },
  },
  {
    scope: "main",
    combos: [{ key: "n" }],
    label: "shortcuts.newEntry",
    run: () => {
      if (vaultId.value && groupId.value && vault.value?.writable)
        actions.newEntry(vaultId.value, groupId.value);
    },
  },
  {
    scope: "main",
    combos: [{ key: "?" }],
    label: "shortcuts.help",
    run: () => {
      dialog.value = { kind: "shortcuts" };
    },
  },
  {
    scope: "tree",
    combos: [{ key: "F2" }],
    label: "shortcuts.rename",
    run: () => {
      tree.value?.startRename();
    },
  },
  {
    scope: "list",
    combos: [{ key: "Enter" }, { key: "e" }],
    label: "shortcuts.edit",
    run: () => {
      const e = current();
      if (e) actions.editEntry(e.vaultId, e.id);
    },
  },
  {
    scope: "list",
    combos: [{ key: "Delete" }, { key: "Backspace" }],
    label: "shortcuts.delete",
    run: () => {
      const items = targets();
      if (vaultId.value && items.length > 0)
        actions.remove(vaultId.value, items);
    },
  },
  {
    scope: "list",
    combos: [{ key: "Delete", shift: true }],
    run: () => {
      const items = targets();
      if (vaultId.value && items.length > 0)
        actions.remove(vaultId.value, items, true);
    },
  },
  {
    scope: "list",
    combos: [{ key: "b", ctrl: true }],
    label: "shortcuts.copyUsername",
    run: () => {
      const e = current();
      if (e) actions.copy(e.vaultId, e.id, "username");
    },
  },
  {
    scope: "detail",
    combos: [{ key: "b", ctrl: true }],
    run: () => {
      const e = current();
      if (e) actions.copy(e.vaultId, e.id, "username");
    },
  },
  {
    scope: "list",
    combos: [
      { key: "u", ctrl: true },
      { key: "u", shift: true },
    ],
    label: "shortcuts.copyUrl",
    run: () => {
      const e = current();
      if (e) actions.copy(e.vaultId, e.id, "url");
    },
  },
  {
    scope: "detail",
    combos: [
      { key: "u", ctrl: true },
      { key: "u", shift: true },
    ],
    run: () => {
      const e = current();
      if (e) actions.copy(e.vaultId, e.id, "url");
    },
  },
  {
    scope: "list",
    combos: [{ key: "u" }],
    label: "shortcuts.openUrl",
    run: () => {
      const e = current();
      if (e) actions.openUrl(e.vaultId, e.id);
    },
  },
  {
    scope: "detail",
    combos: [{ key: "u" }],
    run: () => {
      const e = current();
      if (e) actions.openUrl(e.vaultId, e.id);
    },
  },
  {
    scope: "list",
    combos: [{ key: "t" }],
    label: "shortcuts.copyTotp",
    run: () => {
      const e = current();
      if (e) actions.copyTotp(e.vaultId, e.id);
    },
  },
  {
    scope: "detail",
    combos: [{ key: "t" }],
    run: () => {
      const e = current();
      if (e) actions.copyTotp(e.vaultId, e.id);
    },
  },
  {
    scope: "global",
    combos: [{ key: "Escape" }],
    label: "shortcuts.clearSearch",
    run: () => {
      browse.clearSearch();
    },
  },
]);

/** Ctrl+C in the list or detail copies the password unless text is selected. */
function onCopy(event: ClipboardEvent): void {
  const scope = document.activeElement
    ?.closest("[data-scope]")
    ?.getAttribute("data-scope");
  if (
    (scope !== "list" && scope !== "detail") ||
    isTyping(document.activeElement)
  )
    return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString() !== "")
    return;
  const entry = current();
  const detail = entry && vaults.engine().entry(entry.vaultId, entry.id);
  if (detail)
    copyInEvent(
      event,
      detail.resolved.password.value,
      session.settings.clipboardClearSeconds,
    );
}

onMounted(() => {
  document.addEventListener("copy", onCopy);
});
onBeforeUnmount(() => {
  document.removeEventListener("copy", onCopy);
});

function back(): void {
  if (!vaultId.value) return;
  if (depth.value === "detail" && groupId.value)
    void router.push(groupPath(vaultId.value, groupId.value));
  else void router.push("/vaults");
}
</script>

<template>
  <section
    class="main-view"
    :class="[`depth-${depth}`, `detail-${browse.layout.detail}`]"
    data-test="main-view"
  >
    <div class="main-toolbar" role="toolbar" :aria-label="t('main.toolbar')">
      <button
        v-if="depth !== 'tree'"
        type="button"
        class="icon-button narrow-only"
        :aria-label="t('main.back')"
        data-test="main-back"
        @click="back"
      >
        <AppIcon ui="back" />
      </button>
      <div class="search-box">
        <AppIcon ui="search" />
        <input
          ref="search"
          v-model="browse.search.text"
          type="search"
          :placeholder="t('main.search')"
          :aria-label="t('main.search')"
          autocomplete="off"
          data-test="search"
          @keydown.esc.prevent="
            browse.clearSearch();
            search?.blur();
          "
        />
        <select
          v-model="browse.search.scope"
          :aria-label="t('main.scope')"
          data-test="search-scope"
        >
          <option value="group">{{ t("main.scopes.group") }}</option>
          <option value="vault">{{ t("main.scopes.vault") }}</option>
          <option value="all">{{ t("main.scopes.all") }}</option>
        </select>
        <label class="choice small-text"
          ><input
            v-model="browse.search.includeTrash"
            type="checkbox"
            data-test="search-trash"
          />
          {{ t("main.includeTrash") }}</label
        >
      </div>
      <button
        type="button"
        class="small"
        :disabled="
          !group || !vault?.writable || group.inTrash || group.kind === 'bin'
        "
        data-test="new-entry"
        @click="vaultId && groupId && actions.newEntry(vaultId, groupId)"
      >
        <AppIcon ui="newEntry" /> {{ t("main.newEntry") }}
      </button>
      <button
        type="button"
        class="secondary small"
        :disabled="
          !group || !vault?.writable || group.inTrash || group.kind === 'bin'
        "
        data-test="new-group"
        @click="vaultId && groupId && actions.newGroup(vaultId, groupId)"
      >
        <AppIcon ui="newGroup" /> {{ t("main.newGroup") }}
      </button>
      <label class="choice small-text"
        ><input
          :checked="browse.layout.subgroups"
          type="checkbox"
          data-test="subgroups"
          @change="browse.setLayout({ subgroups: !browse.layout.subgroups })"
        />
        {{ t("main.subgroups") }}</label
      >
      <button
        type="button"
        class="icon-button wide-only"
        :aria-label="
          browse.layout.detail === 'right'
            ? t('main.detailBottom')
            : t('main.detailRight')
        "
        data-test="detail-position"
        @click="
          browse.setLayout({
            detail: browse.layout.detail === 'right' ? 'bottom' : 'right',
          })
        "
      >
        <AppIcon
          :ui="browse.layout.detail === 'right' ? 'panelBottom' : 'panelRight'"
        />
      </button>
      <span
        v-if="vaults.snapshot"
        class="connection"
        :class="`connection-${vaults.snapshot.connection}`"
        data-test="connection"
        :data-state="vaults.snapshot.connection"
      >
        {{ t(`vaults.connection.${vaults.snapshot.connection}`) }}
      </span>
      <button
        type="button"
        class="icon-button"
        :aria-label="t('shortcuts.title')"
        data-test="shortcuts-open"
        @click="dialog = { kind: 'shortcuts' }"
      >
        <AppIcon ui="keyboard" />
      </button>
    </div>

    <p
      v-if="vaults.firstVault === 'creating'"
      class="notice notice-info"
      data-test="first-vault-creating"
    >
      {{ t("vaults.firstCreating") }}
    </p>
    <div
      v-if="vaults.firstVault === 'failed'"
      class="notice notice-error"
      role="alert"
      data-test="first-vault-failed"
    >
      <p>{{ t("vaults.firstFailed") }}</p>
      <button type="button" class="small" @click="vaults.retryFirstVault()">
        {{ t("common.retry") }}
      </button>
    </div>
    <div
      v-if="vault?.rollback"
      class="notice notice-error"
      role="alert"
      data-test="vault-rollback"
    >
      <p>{{ t("vaults.rollback") }}</p>
      <p v-if="vault?.keyRollback" data-test="vault-key-rollback">
        {{ t("vaults.keyRollback") }}
      </p>
      <button
        type="button"
        class="small"
        data-test="vault-rollback-ack"
        @click="acknowledgeRollback"
      >
        {{ t("common.understood") }}
      </button>
    </div>
    <p
      v-else-if="vault && !vault.writable && vault.status === 'ready'"
      class="notice notice-warning"
      data-test="vault-read-only"
    >
      {{ t("vault.readOnly") }}
    </p>
    <WriteNotices :notices="notices" />
    <ErrorNotice :error="error" />
    <p
      v-if="vaults.snapshot?.loaded && vaults.vaults.length === 0"
      class="notice notice-info"
      data-test="vaults-empty"
    >
      {{ t("vaults.empty") }}
      <RouterLink to="/databases">{{ t("vaults.create") }}</RouterLink>
    </p>

    <div class="panes">
      <nav
        class="pane pane-tree"
        data-scope="tree"
        :aria-label="t('tree.label')"
      >
        <VaultTree ref="tree" :vault-id="vaultId" :group-id="groupId" />
      </nav>
      <section
        class="pane pane-list"
        data-scope="list"
        :aria-label="t('list.label')"
      >
        <EntryList
          ref="list"
          :entries="entries"
          :active-id="entryId"
          :searching="browse.searching"
          :path-of="pathOf"
        />
      </section>
      <section
        class="pane pane-detail"
        data-scope="detail"
        :aria-label="t('entry.detail')"
      >
        <EntryEditor
          v-if="
            vaultId &&
            groupId &&
            (mode === 'new' ||
              (mode === 'edit' && entryId && vault?.entries.has(entryId)))
          "
          :key="`${mode}-${entryId ?? ''}`"
          :vault-id="vaultId"
          :group-id="groupId"
          :entry-id="mode === 'edit' ? entryId : undefined"
          @saved="editorSaved"
          @cancel="editorCancel"
        />
        <EntryDetail
          v-else-if="vaultId && entryId"
          :vault-id="vaultId"
          :entry-id="entryId"
          @repaired="dialog = { kind: 'repairEntry', vaultId, entryId }"
        />
        <p v-else class="muted detail-empty">{{ t("entry.none") }}</p>
      </section>
    </div>

    <GroupDialog
      v-if="dialog?.kind === 'group'"
      :vault-id="dialog.vaultId"
      :node="dialog.node"
      :busy="busy"
      @save="saveGroup"
      @close="dialog = undefined"
    />
    <MoveDialog
      v-if="dialog?.kind === 'move'"
      :vault-id="dialog.vaultId"
      :items="dialog.items"
      @move="confirmMove"
      @close="dialog = undefined"
    />
    <ConfirmDialog
      v-if="dialog?.kind === 'across'"
      :title="t('moveDialog.acrossTitle')"
      :text="
        [
          dialog.shared ? t('moveDialog.acrossShared') : t('moveDialog.across'),
          dialog.refs > 0
            ? t('moveDialog.brokenRefs', { count: dialog.refs })
            : '',
        ].join(' ')
      "
      :confirm="t('moveDialog.move')"
      :busy="busy"
      @confirm="confirmAcross"
      @close="dialog = undefined"
    />
    <ConfirmDialog
      v-if="dialog?.kind === 'delete'"
      :title="t('deleteDialog.title')"
      :text="
        t('deleteDialog.text', {
          groups: dialog.groups,
          entries: dialog.entries,
        })
      "
      :confirm="t('tree.deletePermanently')"
      danger
      :busy="busy"
      @confirm="confirmDelete"
      @close="dialog = undefined"
    />
    <ConfirmDialog
      v-if="dialog?.kind === 'emptyBin'"
      :title="t('tree.emptyBin')"
      :text="t('deleteDialog.emptyBin')"
      :confirm="t('tree.emptyBin')"
      danger
      :busy="busy"
      @confirm="confirmEmptyBin"
      @close="dialog = undefined"
    />
    <ConfirmDialog
      v-if="dialog?.kind === 'repairEntry'"
      :title="t('entry.removeInvalid')"
      :text="t('entry.removeInvalidText')"
      :confirm="t('entry.removeInvalid')"
      danger
      :busy="busy"
      @confirm="confirmRepairEntry"
      @close="dialog = undefined"
    />
    <ShortcutsDialog
      v-if="dialog?.kind === 'shortcuts'"
      @close="dialog = undefined"
    />
  </section>
</template>

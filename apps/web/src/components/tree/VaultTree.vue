<script setup lang="ts">
/**
 * The tree of all unlocked vaults: ARIA tree with roving focus,
 * arrow keys, F2, context menu (right click, Shift+F10, menu key), drag and
 * drop with before/after/into. The vault node is the root group.
 */
import type { ItemRef, TreeNode, VaultView } from "@keeman/core";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  dragged,
  dropPosition,
  endDrag,
  startDrag,
  type DropPosition,
} from "../../dnd";
import { customIconSrc } from "../../custom-icons";
import { useBrowseStore } from "../../stores/browse";
import { useVaultsStore } from "../../stores/vaults";
import { useActions } from "../../views/main/actions";
import AppIcon from "../ui/AppIcon";
import ContextMenu from "../ui/ContextMenu.vue";
import type { MenuItem } from "../ui/menu";

const props = defineProps<{ vaultId?: string; groupId?: string }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const browse = useBrowseStore();
const actions = useActions();

interface Row {
  key: string;
  vault: VaultView;
  node: TreeNode;
  level: number;
  setSize: number;
  posInSet: number;
  open: boolean;
}

const focusKey = ref<string>();
const renaming = ref<string>();
const renameTo = ref("");
const menu = ref<{ row: Row; x: number; y: number }>();
const dropTarget = ref<{ key: string; position: DropPosition }>();
const rowElements = new Map<string, HTMLElement>();

function keyOf(vaultId: string, nodeId: string): string {
  return `${vaultId}/${nodeId}`;
}

const rows = computed<Row[]>(() => {
  const list: Row[] = [];
  const all = vaults.vaults;
  const walk = (vault: VaultView, ids: readonly string[], level: number) => {
    ids.forEach((id, index) => {
      const node = vault.tree.nodes.get(id);
      if (!node) return;
      const open = browse.isOpen(vault.id, node);
      list.push({
        key: keyOf(vault.id, id),
        vault,
        node,
        level,
        setSize: ids.length,
        posInSet: index + 1,
        open,
      });
      if (open) walk(vault, node.children, level + 1);
    });
  };
  all.forEach((vault, index) => {
    const root = vault.tree.nodes.get(vault.tree.rootId);
    if (!root) return;
    const open = browse.isOpen(vault.id, root);
    list.push({
      key: keyOf(vault.id, root.id),
      vault,
      node: root,
      level: 1,
      setSize: all.length,
      posInSet: index + 1,
      open,
    });
    if (open) walk(vault, root.children, 2);
  });
  return list;
});

const selectedKey = computed(() =>
  props.vaultId && props.groupId
    ? keyOf(props.vaultId, props.groupId)
    : undefined,
);
const tabKey = computed(() => {
  const keys = rows.value.map((r) => r.key);
  for (const key of [focusKey.value, selectedKey.value])
    if (key && keys.includes(key)) return key;
  return keys[0];
});

watch(selectedKey, (key) => {
  if (key) focusKey.value = key;
});

function label(row: Row): string {
  if (row.node.kind === "root") return row.vault.name ?? t("vaults.unnamed");
  return row.node.name === "" ? t("tree.unnamed") : row.node.name;
}

function focusRow(key: string | undefined): void {
  if (!key) return;
  focusKey.value = key;
  void nextTick(() => rowElements.get(key)?.focus());
}

function select(row: Row): void {
  focusKey.value = row.key;
  actions.selectGroup(row.vault.id, row.node.id);
}

function toggle(row: Row, open = !row.open): void {
  if (row.node.children.length === 0) return;
  browse.setOpen(row.vault.id, row.node, open);
}

function parentRow(row: Row): Row | undefined {
  const parent = row.node.parentId;
  return parent
    ? rows.value.find((r) => r.key === keyOf(row.vault.id, parent))
    : undefined;
}

function startRename(row: Row): void {
  if (row.node.kind !== "group" || !row.node.writable) return;
  renaming.value = row.key;
  renameTo.value = row.node.name;
  void nextTick(() =>
    document
      .querySelector<HTMLInputElement>("[data-test=tree-rename]")
      ?.select(),
  );
}

async function finishRename(row: Row): Promise<void> {
  const name = renameTo.value;
  if (await actions.renameGroup(row.vault.id, row.node.id, name)) {
    renaming.value = undefined;
    focusRow(row.key);
  }
}

function cancelRename(row: Row): void {
  renaming.value = undefined;
  focusRow(row.key);
}

function ref_(row: Row): ItemRef {
  return { kind: "group", id: row.node.id };
}

function openMenu(row: Row, x?: number, y?: number): void {
  const element = rowElements.get(row.key);
  const box = element?.getBoundingClientRect();
  focusKey.value = row.key;
  menu.value = {
    row,
    x: x ?? (box ? box.left + 24 : 0),
    y: y ?? (box ? box.bottom : 0),
  };
}

const menuItems = computed<MenuItem[]>(() => {
  const row = menu.value?.row;
  if (!row) return [];
  const { node, vault } = row;
  const writable = vault.writable;
  const items: MenuItem[] = [];
  if (node.kind === "bin") {
    items.push({
      key: "emptyBin",
      label: t("tree.emptyBin"),
      ui: "delete",
      danger: true,
      disabled:
        !writable || (node.children.length === 0 && node.entries.length === 0),
    });
  } else if (node.inTrash) {
    items.push({
      key: "restore",
      label: t("tree.restore"),
      ui: "restore",
      disabled: !node.writable,
    });
    items.push({
      key: "delete",
      label: t("tree.deletePermanently"),
      ui: "delete",
      danger: true,
      disabled: !node.writable,
    });
  } else {
    items.push({
      key: "newGroup",
      label: t("tree.newGroup"),
      ui: "newGroup",
      disabled: !writable || node.problem === "missing",
    });
    items.push({
      key: "newEntry",
      label: t("tree.newEntry"),
      ui: "newEntry",
      disabled: !writable || node.problem === "missing",
    });
    items.push({
      key: "properties",
      label: t("tree.properties"),
      ui: "settings",
      disabled: !node.writable,
    });
    if (node.kind === "group") {
      items.push({
        key: "rename",
        label: t("tree.rename"),
        ui: "edit",
        disabled: !node.writable,
      });
      items.push({
        key: "move",
        label: t("tree.move"),
        ui: "move",
        disabled: !node.writable,
      });
      items.push({
        key: "up",
        label: t("tree.up"),
        ui: "up",
        disabled: !node.writable || row.posInSet === 1,
      });
      items.push({
        key: "down",
        label: t("tree.down"),
        ui: "down",
        disabled: !node.writable || row.posInSet === row.setSize,
      });
      items.push({
        key: "delete",
        label: t("tree.delete"),
        ui: "delete",
        danger: true,
        disabled: !node.writable,
      });
    }
  }
  if (node.kind === "root")
    items.push({ key: "database", label: t("tree.database"), ui: "settings" });
  if (
    (node.kind === "root" && vault.tree.repairs.length > 0) ||
    vault.tree.missingRoot ||
    node.problem
  )
    items.push({
      key: "repair",
      label: t("tree.repair"),
      ui: "repair",
      disabled: !writable,
    });
  return items;
});

function onMenu(key: string): void {
  const row = menu.value?.row;
  menu.value = undefined;
  if (!row) return;
  const { vault, node } = row;
  switch (key) {
    case "newGroup":
      actions.newGroup(vault.id, node.id);
      break;
    case "newEntry":
      actions.newEntry(vault.id, node.id);
      break;
    case "properties":
      actions.groupProperties(vault.id, node.id);
      break;
    case "rename":
      startRename(row);
      break;
    case "move":
      actions.moveDialog(vault.id, [ref_(row)]);
      break;
    case "up":
    case "down":
      actions.reorderGroup(vault.id, node.id, key === "up" ? -1 : 1);
      break;
    case "delete":
      actions.remove(vault.id, [ref_(row)]);
      break;
    case "restore":
      actions.restore(vault.id, [ref_(row)]);
      break;
    case "emptyBin":
      actions.emptyBin(vault.id);
      break;
    case "repair":
      actions.repair(vault.id);
      break;
    case "database":
      actions.databaseSettings(vault.id);
      break;
  }
}

function onKeydown(event: KeyboardEvent, row: Row): void {
  if (renaming.value) return;
  const list = rows.value;
  const index = list.findIndex((r) => r.key === row.key);
  const go = (i: number) => {
    focusRow(list[Math.max(0, Math.min(list.length - 1, i))]?.key);
  };
  switch (event.key) {
    case "ArrowDown":
      go(index + 1);
      break;
    case "ArrowUp":
      go(index - 1);
      break;
    case "Home":
      go(0);
      break;
    case "End":
      go(list.length - 1);
      break;
    case "ArrowRight":
      if (row.node.children.length === 0) return;
      if (!row.open) toggle(row, true);
      else go(index + 1);
      break;
    case "ArrowLeft":
      if (row.open && row.node.children.length > 0) toggle(row, false);
      else focusRow(parentRow(row)?.key);
      break;
    case "Enter":
    case " ":
      select(row);
      break;
    case "F2":
      startRename(row);
      break;
    case "ContextMenu":
      openMenu(row);
      break;
    case "F10":
      if (!event.shiftKey) return;
      openMenu(row);
      break;
    case "Delete":
      if (row.node.kind !== "group") return;
      if (row.node.inTrash) actions.remove(row.vault.id, [ref_(row)], true);
      else actions.remove(row.vault.id, [ref_(row)]);
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
}

// ------------------------------------------------------------ drag and drop

function onDragStart(event: DragEvent, row: Row): void {
  if (row.node.kind !== "group" || !row.node.writable) {
    event.preventDefault();
    return;
  }
  startDrag(event, { vaultId: row.vault.id, items: [ref_(row)] });
}

function target(row: Row, position: DropPosition) {
  if (position === "into" || row.node.parentId === null)
    return { vaultId: row.vault.id, groupId: row.node.id };
  const parent = row.vault.tree.nodes.get(row.node.parentId);
  const siblings = parent?.children ?? [];
  const index = siblings.indexOf(row.node.id);
  const before = position === "before" ? row.node.id : siblings[index + 1];
  return { vaultId: row.vault.id, groupId: row.node.parentId, before };
}

function onDragOver(event: DragEvent, row: Row): void {
  const payload = dragged(event);
  const element = rowElements.get(row.key);
  if (!payload || !element) return;
  const groups = payload.items.some((i) => i.kind === "group");
  const position = dropPosition(
    event,
    element,
    groups && row.node.kind === "group",
  );
  const check = vaults
    .engine()
    .canMove(payload.vaultId, payload.items, target(row, position));
  if (!check.ok) {
    dropTarget.value = undefined;
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTarget.value = { key: row.key, position };
  // Hovering over a closed group opens it after a moment.
  if (position === "into" && !row.open) scheduleOpen(row);
}

let openTimer: ReturnType<typeof setTimeout> | undefined;
let openKey: string | undefined;
function scheduleOpen(row: Row): void {
  if (openKey === row.key) return;
  clearTimeout(openTimer);
  openKey = row.key;
  openTimer = setTimeout(() => {
    toggle(row, true);
    openKey = undefined;
  }, 800);
}

function onDragLeave(row: Row): void {
  if (dropTarget.value?.key === row.key) dropTarget.value = undefined;
}

function onDrop(event: DragEvent, row: Row): void {
  const payload = dragged(event);
  const position = dropTarget.value?.position ?? "into";
  dropTarget.value = undefined;
  clearTimeout(openTimer);
  openKey = undefined;
  if (!payload) return;
  event.preventDefault();
  endDrag();
  actions.drop(payload, target(row, position));
}

function onDragEnd(): void {
  dropTarget.value = undefined;
  endDrag();
}

function setRef(key: string, element: unknown): void {
  if (element instanceof HTMLElement) rowElements.set(key, element);
  else rowElements.delete(key);
}

defineExpose({
  focusSelected: () => {
    focusRow(tabKey.value);
  },
  startRename: () => {
    const row = rows.value.find((r) => r.key === tabKey.value);
    if (row) startRename(row);
  },
});
</script>

<template>
  <ul class="tree" role="tree" :aria-label="t('tree.label')" data-test="tree">
    <li
      v-for="row in rows"
      :key="row.key"
      :ref="(el) => setRef(row.key, el)"
      role="treeitem"
      class="tree-row"
      :class="{
        selected: row.key === selectedKey,
        'drop-before':
          dropTarget?.key === row.key && dropTarget.position === 'before',
        'drop-after':
          dropTarget?.key === row.key && dropTarget.position === 'after',
        'drop-into':
          dropTarget?.key === row.key && dropTarget.position === 'into',
        'in-trash': row.node.inTrash,
      }"
      :style="{ paddingInlineStart: `${(row.level - 1) * 1.1 + 0.25}rem` }"
      :aria-level="row.level"
      :aria-setsize="row.setSize"
      :aria-posinset="row.posInSet"
      :aria-expanded="row.node.children.length > 0 ? row.open : undefined"
      :aria-selected="row.key === selectedKey"
      :tabindex="row.key === tabKey ? 0 : -1"
      :draggable="row.node.kind === 'group' && row.node.writable"
      data-test="tree-row"
      :data-node-id="row.node.id"
      :data-kind="row.node.kind"
      :data-vault-id="row.vault.id"
      @click="select(row)"
      @dblclick="toggle(row)"
      @keydown="onKeydown($event, row)"
      @focus="focusKey = row.key"
      @contextmenu.prevent="openMenu(row, $event.clientX, $event.clientY)"
      @dragstart="onDragStart($event, row)"
      @dragover="onDragOver($event, row)"
      @dragleave="onDragLeave(row)"
      @drop="onDrop($event, row)"
      @dragend="onDragEnd"
    >
      <span
        class="tree-toggle"
        :class="{ invisible: row.node.children.length === 0 }"
        aria-hidden="true"
        @click.stop="toggle(row)"
      >
        <AppIcon :ui="row.open ? 'chevronDown' : 'chevronRight'" :size="14" />
      </span>
      <span
        v-if="row.node.kind === 'root'"
        class="swatch small"
        :style="
          row.vault.color ? { backgroundColor: row.vault.color } : undefined
        "
        aria-hidden="true"
      ></span>
      <AppIcon
        :name="row.node.icon"
        :src="customIconSrc(row.vault, row.node.customIcon)"
        :fallback="row.node.kind === 'bin' ? 'trash-2' : 'folder'"
      />
      <input
        v-if="renaming === row.key"
        v-model="renameTo"
        class="tree-rename"
        maxlength="256"
        :aria-label="t('tree.newName')"
        data-test="tree-rename"
        @click.stop
        @keydown.enter.prevent.stop="finishRename(row)"
        @keydown.esc.prevent.stop="cancelRename(row)"
        @blur="cancelRename(row)"
      />
      <span v-else class="tree-name" data-test="tree-name">{{
        label(row)
      }}</span>
      <span v-if="row.node.problem === 'orphan'" class="tag text-warning">{{
        t("tree.orphan")
      }}</span>
      <span v-if="row.node.problem === 'cycle'" class="tag text-warning">{{
        t("tree.cycle")
      }}</span>
      <span v-if="row.node.problem === 'missing'" class="tag text-error">{{
        t("tree.missingRoot")
      }}</span>
      <span
        v-if="
          row.node.kind === 'root' &&
          (row.vault.rollback ||
            row.vault.manifest === 'mismatch' ||
            row.vault.freshness === 'stale' ||
            row.vault.roles.status === 'rollback' ||
            row.vault.roles.status === 'fork' ||
            row.vault.roles.status === 'invalid' ||
            row.vault.roles.status === 'unavailable' ||
            row.vault.corrupt.length > 0)
        "
        class="tag text-error"
        data-test="tree-vault-warning"
        :title="
          row.vault.manifest === 'mismatch'
            ? t('vaults.manifest.withheld')
            : row.vault.rollback
              ? t('vaults.rollback')
              : row.vault.freshness === 'stale'
                ? t('freshness.tree')
                : row.vault.corrupt.length > 0
                  ? t('vaults.corrupt', { count: row.vault.corrupt.length })
                  : t('vaults.roles.tree')
        "
      >
        <AppIcon ui="warning" :size="14" />
      </span>
      <span
        v-if="row.node.kind === 'root' && row.vault.status === 'loading'"
        class="muted small-text"
      >
        {{ t("vaults.loading") }}
      </span>
      <span
        v-if="row.node.kind === 'root' && row.vault.status === 'error'"
        class="text-error small-text"
      >
        {{ t("vaults.status.error") }}
      </span>
    </li>
  </ul>
  <ContextMenu
    v-if="menu"
    :items="menuItems"
    :x="menu.x"
    :y="menu.y"
    :label="t('tree.menu')"
    @select="onMenu"
    @close="menu = undefined"
  />
</template>

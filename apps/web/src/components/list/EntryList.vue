<script setup lang="ts">
/**
 * Entries of the selected group or of a search: ARIA grid, only
 * visible rows rendered, sortable columns, multiple selection with mouse and
 * keyboard, drag into the tree. Vault content is text only.
 */
import type { EntrySummary, VaultView } from "@keeman/core";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { endDrag, startDrag } from "../../dnd";
import { formatDate } from "../../format";
import { currentLocale } from "../../i18n";
import { customIconSrc } from "../../custom-icons";
import { useBrowseStore } from "../../stores/browse";
import type { ViewLayout } from "../../storage";
import { useActions } from "../../views/main/actions";
import { useSessionStore } from "../../stores/session";
import { useVaultsStore } from "../../stores/vaults";
import AppIcon from "../ui/AppIcon";
import TotpCell from "./TotpCell.vue";
import VirtualList from "./VirtualList.vue";

const props = defineProps<{
  entries: readonly EntrySummary[];
  activeId?: string;
  searching: boolean;
  /** Group names of the path, for search results. */
  pathOf: (entry: EntrySummary) => string;
}>();
const { t } = useI18n();
const browse = useBrowseStore();
const actions = useActions();
const session = useSessionStore();
const vaults = useVaultsStore();
const vaultById = computed(
  () => new Map<string, VaultView>(vaults.vaults.map((v) => [v.id, v])),
);
const list = ref<{ scrollToIndex(index: number): void }>();
const grid = ref<HTMLElement>();
const focusId = ref<string>();

const columns: ViewLayout["sort"][] = ["title", "username", "url", "modified"];

const sorted = computed(() => {
  const { sort, dir } = browse.layout;
  const collator = new Intl.Collator(currentLocale(), {
    numeric: true,
    sensitivity: "base",
  });
  const value = (entry: EntrySummary): string =>
    sort === "modified" ? (entry.modified ?? "") : entry[sort];
  const factor = dir === "asc" ? 1 : -1;
  return [...props.entries].sort(
    (a, b) =>
      factor *
        (sort === "modified"
          ? value(a).localeCompare(value(b))
          : collator.compare(value(a), value(b))) ||
      collator.compare(a.title, b.title) ||
      a.id.localeCompare(b.id),
  );
});

/** The TOTP column only when enabled and some entry has TOTP. */
const withTotp = computed(
  () =>
    session.settings.showTotpColumn &&
    props.entries.some((entry) => entry.totp !== "none"),
);
const selected = computed(() => new Set(browse.selection));
const activeIndex = computed(() => {
  const id = focusId.value ?? props.activeId;
  return sorted.value.findIndex((e) => e.id === id);
});
const tabId = computed(() => sorted.value[Math.max(0, activeIndex.value)]?.id);

watch(
  () => props.activeId,
  (id) => {
    if (id) focusId.value = id;
  },
  { immediate: true },
);

function now(): string {
  return new Date().toISOString();
}

function title(entry: EntrySummary): string {
  return entry.title === "" ? t("entry.untitled") : entry.title;
}

function sortBy(column: ViewLayout["sort"]): void {
  const { sort, dir } = browse.layout;
  browse.setLayout({
    sort: column,
    dir: sort === column && dir === "asc" ? "desc" : "asc",
  });
}

function ariaSort(
  column: ViewLayout["sort"],
): "ascending" | "descending" | "none" {
  if (browse.layout.sort !== column) return "none";
  return browse.layout.dir === "asc" ? "ascending" : "descending";
}

function focusEntry(index: number, extend = false): void {
  const entry =
    sorted.value[Math.max(0, Math.min(sorted.value.length - 1, index))];
  if (!entry) return;
  focusId.value = entry.id;
  if (extend) {
    const anchor = sorted.value.findIndex((e) => e.id === browse.anchor);
    const [from, to] =
      anchor < 0
        ? [index, index]
        : [Math.min(anchor, index), Math.max(anchor, index)];
    browse.select(
      sorted.value.slice(from, to + 1).map((e) => e.id),
      browse.anchor,
    );
  } else {
    browse.select([entry.id]);
    actions.openEntry(entry.vaultId, entry.id);
  }
  list.value?.scrollToIndex(sorted.value.indexOf(entry));
  void nextTick(() =>
    grid.value
      ?.querySelector<HTMLElement>(`[data-entry-id="${entry.id}"]`)
      ?.focus(),
  );
}

function onClick(event: MouseEvent, entry: EntrySummary): void {
  focusId.value = entry.id;
  const index = sorted.value.indexOf(entry);
  if (event.shiftKey) {
    focusEntry(index, true);
  } else if (event.ctrlKey || event.metaKey) {
    const set = new Set(browse.selection);
    if (set.has(entry.id)) set.delete(entry.id);
    else set.add(entry.id);
    browse.select([...set], entry.id);
  } else {
    browse.select([entry.id]);
    actions.openEntry(entry.vaultId, entry.id);
  }
}

function onKeydown(event: KeyboardEvent): void {
  const index = activeIndex.value;
  const page = Math.max(
    1,
    Math.floor((grid.value?.clientHeight ?? 400) / 34) - 1,
  );
  const extend = event.shiftKey;
  switch (event.key) {
    case "ArrowDown":
      focusEntry(index + 1, extend);
      break;
    case "ArrowUp":
      focusEntry(index - 1, extend);
      break;
    case "PageDown":
      focusEntry(index + page, extend);
      break;
    case "PageUp":
      focusEntry(index - page, extend);
      break;
    case "Home":
      focusEntry(0, extend);
      break;
    case "End":
      focusEntry(sorted.value.length - 1, extend);
      break;
    case " ": {
      if (!(event.ctrlKey || event.metaKey)) return;
      const id = tabId.value;
      if (!id) return;
      const set = new Set(browse.selection);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      browse.select([...set], id);
      break;
    }
    case "a":
      if (!(event.ctrlKey || event.metaKey)) return;
      browse.select(
        sorted.value.map((e) => e.id),
        tabId.value,
      );
      break;
    default:
      return;
  }
  event.preventDefault();
}

function onDragStart(event: DragEvent, entry: EntrySummary): void {
  const ids = selected.value.has(entry.id) ? browse.selection : [entry.id];
  const entries = sorted.value.filter((e) => ids.includes(e.id) && e.writable);
  if (entries.length === 0) {
    event.preventDefault();
    return;
  }
  startDrag(event, {
    vaultId: entry.vaultId,
    items: entries
      .filter((e) => e.vaultId === entry.vaultId)
      .map((e) => ({ kind: "entry" as const, id: e.id })),
  });
}

defineExpose({
  focus: () => {
    focusEntry(Math.max(0, activeIndex.value));
  },
});
</script>

<template>
  <div
    ref="grid"
    class="entry-list"
    role="grid"
    :aria-label="searching ? t('list.results') : t('list.label')"
    :aria-rowcount="sorted.length + 1"
    aria-multiselectable="true"
    data-test="entry-list"
    @keydown="onKeydown"
  >
    <div role="rowgroup" class="list-head">
      <div
        role="row"
        aria-rowindex="1"
        class="list-row list-header"
        :class="{ 'with-path': searching, 'with-totp': withTotp }"
      >
        <span role="columnheader" class="col-icon"
          ><span class="sr-only">{{ t("list.icon") }}</span></span
        >
        <template v-for="column in columns" :key="column">
          <span
            v-if="column === 'modified' && withTotp"
            role="columnheader"
            class="col-totp"
            data-test="totp-column"
            >{{ t("list.columns.totp") }}</span
          >
          <span
            role="columnheader"
            :class="`col-${column}`"
            :aria-sort="ariaSort(column)"
          >
            <button
              type="button"
              class="link sort-button"
              :data-test="`sort-${column}`"
              @click="sortBy(column)"
            >
              {{ t(`list.columns.${column}`) }}
              <AppIcon
                v-if="browse.layout.sort === column"
                :ui="browse.layout.dir === 'asc' ? 'up' : 'down'"
                :size="12"
              />
            </button>
          </span>
        </template>
        <span v-if="searching" role="columnheader" class="col-path">{{
          t("list.columns.path")
        }}</span>
      </div>
    </div>
    <VirtualList
      ref="list"
      class="list-body"
      :items="sorted"
      :item-key="(entry) => entry.id"
      :active="activeIndex"
    >
      <template #default="{ item, index }">
        <div
          role="row"
          class="list-row"
          :class="{
            selected: selected.has(item.id),
            active: item.id === activeId,
            expired: item.expires !== null && item.expires <= now(),
            'with-path': searching,
            'with-totp': withTotp,
          }"
          :aria-rowindex="index + 2"
          :aria-selected="selected.has(item.id)"
          :tabindex="item.id === tabId ? 0 : -1"
          :draggable="item.writable"
          data-test="entry-row"
          :data-entry-id="item.id"
          @click="onClick($event, item)"
          @dblclick="actions.editEntry(item.vaultId, item.id)"
          @focus="focusId = item.id"
          @dragstart="onDragStart($event, item)"
          @dragend="endDrag()"
        >
          <span role="gridcell" class="col-icon"
            ><AppIcon
              :name="item.icon"
              :src="
                customIconSrc(vaultById.get(item.vaultId), item.customIcon)
              "
          /></span>
          <span role="gridcell" class="col-title" data-test="entry-title">
            {{ title(item) }}
            <span v-if="item.problem === 'orphan'" class="tag text-warning">{{
              t("tree.orphan")
            }}</span>
            <span v-if="item.rollback || item.readOnly" class="tag text-error">
              <AppIcon ui="warning" :size="12" />
            </span>
          </span>
          <span
            role="gridcell"
            class="col-username"
            data-test="entry-username"
            >{{ item.username }}</span
          >
          <span role="gridcell" class="col-url" data-test="entry-url">{{
            item.url
          }}</span>
          <span v-if="withTotp" role="gridcell" class="col-totp">
            <TotpCell
              v-if="item.totp !== 'none'"
              :vault-id="item.vaultId"
              :entry-id="item.id"
            />
          </span>
          <span role="gridcell" class="col-modified">{{
            formatDate(item.modified)
          }}</span>
          <span v-if="searching" role="gridcell" class="col-path">{{
            pathOf(item)
          }}</span>
        </div>
      </template>
    </VirtualList>
    <p
      v-if="sorted.length === 0"
      class="muted list-empty"
      data-test="list-empty"
    >
      {{ searching ? t("list.noResults") : t("list.empty") }}
    </p>
  </div>
</template>

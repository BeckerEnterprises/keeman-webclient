<script setup lang="ts">
/**
 * Choosing an icon: the vault's own icons and the built-in ones
 * with a search, one radio group, so arrows move. Uploading and fetching a
 * favicon write the icon into the vault's library at once and
 * choose it; only the origin of a URL goes to the server.
 */
import {
  BUILTIN_ICONS,
  faviconIconName,
  faviconTarget,
  uploadIconName,
  type IconRef,
  type IconSource,
} from "@keeman/core";
import { computed, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { encodeIcon } from "../../icon-image";
import { imageOf } from "../../qr";
import { useSessionStore } from "../../stores/session";
import { useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import AppIcon from "./AppIcon";

const props = defineProps<{
  label: string;
  noneLabel?: string;
  fallback: string;
  vaultId: string;
  /** Pre-filled for "Fetch favicon", e.g. the entry's URL. */
  faviconUrl?: string;
}>();
const model = defineModel<IconRef | null>({ required: true });
const { t } = useI18n();
const session = useSessionStore();
const vaults = useVaultsStore();
const filter = ref("");
const name = useId();
const fileInput = ref<HTMLInputElement>();
const url = ref(props.faviconUrl ?? "");
const busy = ref(false);
const error = ref<UiError>();

const vault = computed(() => vaults.vaults.find((v) => v.id === props.vaultId));
const writable = computed(() => vault.value?.writable === true);
const custom = computed(() =>
  [...(vault.value?.icons.values() ?? [])].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  ),
);
const current = computed(() => {
  const value = model.value;
  if (value === null) return "";
  return value.type === "builtin" ? value.name : `custom:${value.id}`;
});
const icons = computed(() => {
  const text = filter.value.trim().toLowerCase();
  return BUILTIN_ICONS.filter((icon) => text === "" || icon.includes(text));
});
// Follows the pre-filled URL until the field is edited.
watch(
  () => props.faviconUrl,
  (next, previous) => {
    if (url.value === (previous ?? "")) url.value = next ?? "";
  },
);
const canFetch = computed(
  () => !busy.value && faviconTarget(url.value) !== undefined,
);

function choose(icon: string): void {
  model.value = icon === "" ? null : { type: "builtin", name: icon };
}

function chooseCustom(id: string): void {
  model.value = { type: "custom", id };
}

/** Re-encodes the image, adds it to the library and chooses it. */
async function add(
  image: Blob,
  iconName: string,
  source: IconSource,
): Promise<void> {
  // The engine of this unlock: a lock while encoding ends it.
  const engine = vaults.engine();
  const png = await encodeIcon(image);
  chooseCustom(await engine.addIcon(props.vaultId, png, iconName, source));
}

async function run(task: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = undefined;
  try {
    await task();
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

function upload(file: File | undefined): void {
  if (!file || !writable.value) return;
  void run(() => add(file, uploadIconName(file.name), { type: "upload" }));
}

function picked(event: Event): void {
  const input = event.target as HTMLInputElement;
  upload(input.files?.[0]);
  input.value = "";
}

function fetchFavicon(): void {
  if (!canFetch.value) return;
  void run(async () => {
    const { png, origin } = await vaults.engine().favicon(url.value);
    await add(
      new Blob([png.slice()], { type: "image/png" }),
      faviconIconName(origin),
      {
        type: "favicon",
        origin,
      },
    );
  });
}
</script>

<template>
  <fieldset
    class="icon-picker"
    data-test="icon-picker"
    @drop.prevent="upload(imageOf($event.dataTransfer))"
    @dragover.prevent
    @paste="upload(imageOf($event.clipboardData))"
  >
    <legend>{{ props.label }}</legend>
    <div v-if="custom.length > 0 || writable" class="icon-custom-section">
      <span class="icon-section-title">{{ t("icons.custom") }}</span>
      <div
        v-if="custom.length > 0"
        class="icon-grid"
        data-test="icon-custom-grid"
      >
        <label
          v-for="icon in custom"
          :key="icon.id"
          class="icon-option"
          :title="icon.name || t('icons.unnamed')"
        >
          <input
            type="radio"
            :name="name"
            :value="`custom:${icon.id}`"
            :checked="current === `custom:${icon.id}`"
            data-test="icon-custom"
            @change="chooseCustom(icon.id)"
          />
          <AppIcon :src="icon.src" :name="fallback" :size="20" />
          <span class="sr-only">{{ icon.name || t("icons.unnamed") }}</span>
        </label>
      </div>
      <div v-if="writable" class="icon-actions">
        <button
          type="button"
          class="secondary"
          :disabled="busy"
          data-test="icon-upload"
          @click="fileInput?.click()"
        >
          {{ t("icons.upload") }}
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="image/*,.ico,.svg"
          class="sr-only"
          tabindex="-1"
          data-test="icon-upload-file"
          @change="picked"
        />
        <template v-if="session.favicon">
          <input
            v-model="url"
            type="text"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            class="icon-url"
            :aria-label="t('icons.faviconUrl')"
            :placeholder="t('icons.faviconPlaceholder')"
            data-test="icon-favicon-url"
            @keydown.enter.prevent="fetchFavicon"
          />
          <button
            type="button"
            class="secondary"
            :disabled="!canFetch"
            data-test="icon-favicon"
            @click="fetchFavicon"
          >
            {{ t("icons.fetchFavicon") }}
          </button>
        </template>
      </div>
      <p v-if="writable && session.favicon" class="hint">
        {{ t("icons.faviconHint") }}
      </p>
      <p v-if="busy" class="hint" role="status">{{ t("icons.working") }}</p>
      <ErrorNotice :error="error" />
    </div>
    <span class="icon-section-title">{{ t("icons.builtin") }}</span>
    <input
      v-model="filter"
      type="search"
      class="icon-filter"
      :aria-label="t('icons.search')"
      data-test="icon-filter"
    />
    <div class="icon-grid">
      <label
        v-if="noneLabel !== undefined"
        class="icon-option icon-none"
        :title="noneLabel"
      >
        <input
          type="radio"
          :name="name"
          value=""
          :checked="current === ''"
          data-test="icon-none"
          @change="choose('')"
        />
        <AppIcon :name="fallback" :size="20" />
        <span class="sr-only">{{ noneLabel }}</span>
      </label>
      <label
        v-for="icon in icons"
        :key="icon"
        class="icon-option"
        :title="icon"
      >
        <input
          type="radio"
          :name="name"
          :value="icon"
          :checked="current === icon"
          :data-test="`icon-${icon}`"
          @change="choose(icon)"
        />
        <AppIcon :name="icon" :size="20" />
        <span class="sr-only">{{ icon }}</span>
      </label>
    </div>
  </fieldset>
</template>

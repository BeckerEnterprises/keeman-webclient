<script setup lang="ts">
/**
 * Attachments of an entry or of one of its history states:
 * name and size, preview of images and short text, download. The
 * core decrypts; the bytes stay in this component only while shown.
 */
import type { AttachmentInfo } from "@keeman/core";
import { onBeforeUnmount, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  preview,
  previewKind,
  saveFile,
  type Preview,
} from "../../attachments";
import { toUiError, type UiError } from "../../errors";
import { formatBytes } from "../../format";
import { useSessionStore } from "../../stores/session";
import { useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import AppIcon from "../ui/AppIcon";

const props = defineProps<{
  vaultId: string;
  entryId: string;
  attachments: readonly AttachmentInfo[];
}>();
const { t } = useI18n();
const vaults = useVaultsStore();
const session = useSessionStore();
const shown = ref<Preview>();
const error = ref<UiError>();
/** Percent per attachment while it is being fetched. */
const loading = reactive(new Map<string, number>());

function close(): void {
  if (shown.value?.kind === "image") URL.revokeObjectURL(shown.value.url);
  shown.value = undefined;
}

async function fetchFile(info: AttachmentInfo): Promise<Uint8Array> {
  loading.set(info.id, 0);
  try {
    return await vaults
      .engine()
      .readAttachment(props.vaultId, props.entryId, info.id, {
        onProgress: ({ done, total }) => {
          session.markActivity();
          loading.set(info.id, Math.floor((100 * done) / Math.max(total, 1)));
        },
      });
  } finally {
    loading.delete(info.id);
  }
}

async function show(info: AttachmentInfo): Promise<void> {
  error.value = undefined;
  try {
    const bytes = await fetchFile(info);
    close();
    shown.value = preview(info, bytes);
  } catch (caught) {
    error.value = toUiError(caught);
  }
}

async function download(info: AttachmentInfo): Promise<void> {
  error.value = undefined;
  try {
    saveFile(await fetchFile(info), info.name);
  } catch (caught) {
    error.value = toUiError(caught);
  }
}

watch(
  () => [props.entryId, props.attachments] as const,
  () => {
    close();
    error.value = undefined;
  },
);
onBeforeUnmount(close);
</script>

<template>
  <div class="secret-value attachment-block" data-test="attachments">
    <dt>{{ t("attachments.title") }}</dt>
    <dd class="attachment-body">
      <ul class="attachment-list">
        <li
          v-for="info in attachments"
          :key="info.id"
          class="attachment-row"
          data-test="attachment"
        >
          <span class="attachment-name" data-test="attachment-name">{{
            info.name || t("attachments.unnamed")
          }}</span>
          <span class="muted small-text">{{ formatBytes(info.size) }}</span>
          <span
            v-if="loading.has(info.id)"
            class="muted small-text"
            aria-live="polite"
            data-test="attachment-progress"
            >{{ loading.get(info.id) }} %</span
          >
          <button
            v-if="previewKind(info)"
            type="button"
            class="small secondary"
            :disabled="loading.has(info.id)"
            data-test="attachment-preview"
            @click="show(info)"
          >
            {{ t("attachments.preview") }}
          </button>
          <button
            type="button"
            class="icon-button"
            :aria-label="t('attachments.download', { name: info.name })"
            :disabled="loading.has(info.id)"
            data-test="attachment-download"
            @click="download(info)"
          >
            <AppIcon ui="download" />
          </button>
        </li>
      </ul>
      <figure
        v-if="shown"
        class="attachment-preview"
        data-test="attachment-preview-box"
      >
        <img
          v-if="shown.kind === 'image'"
          :src="shown.url"
          :alt="shown.name"
          data-test="attachment-preview-image"
        />
        <pre v-else class="notes" data-test="attachment-preview-text">{{
          shown.text
        }}</pre>
        <figcaption>
          <span class="muted small-text">{{ shown.name }}</span>
          <button
            type="button"
            class="small secondary"
            data-test="attachment-preview-close"
            @click="close"
          >
            {{ t("common.close") }}
          </button>
        </figcaption>
      </figure>
      <ErrorNotice :error="error" />
    </dd>
  </div>
</template>

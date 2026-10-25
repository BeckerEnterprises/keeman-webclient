<script setup lang="ts">
/**
 * The attachments tab of the editor: new files are compressed,
 * encrypted and uploaded at once by the core; saving the entry
 * completes them. Files the editor gives up on are deleted again, also
 * when the editor closes without saving.
 */
import { MAX_ATTACHMENTS, SyncError, type AttachmentInfo } from "@keeman/core";
import { onBeforeUnmount, onMounted, reactive, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { formatBytes } from "../../format";
import { useSessionStore } from "../../stores/session";
import { useVaultsStore } from "../../stores/vaults";
import ErrorNotice from "../ErrorNotice.vue";
import AppIcon from "../ui/AppIcon";

const props = defineProps<{
  vaultId: string;
  entryId: string;
  /** Metadata of the attachments the entry has stored. */
  stored: readonly AttachmentInfo[];
}>();
const model = defineModel<string[]>({ required: true });
const emit = defineEmits<{ uploading: [count: number] }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const session = useSessionStore();
const inputId = useId();

interface Upload {
  key: number;
  name: string;
  done: number;
  total: number;
  controller: AbortController;
}

const infos = reactive(new Map(props.stored.map((info) => [info.id, info])));
const staged = new Set<string>();
const uploads = ref<Upload[]>([]);
const limit = ref<number>();
const error = ref<UiError>();
let next = 0;

onMounted(async () => {
  try {
    limit.value = await vaults.engine().attachmentLimit();
  } catch {
    limit.value = undefined;
  }
});

function report(): void {
  emit("uploading", uploads.value.length);
}

async function upload(file: File, item: Upload): Promise<void> {
  try {
    if (item.controller.signal.aborted) return;
    const data = new Uint8Array(await file.arrayBuffer());
    const info = await vaults.engine().stageAttachment(
      props.vaultId,
      props.entryId,
      { name: file.name, mime: file.type, data },
      {
        signal: item.controller.signal,
        onProgress: ({ done, total }) => {
          session.markActivity();
          item.done = done;
          item.total = total;
        },
      },
    );
    staged.add(info.id);
    infos.set(info.id, info);
    model.value = [...model.value, info.id];
  } catch (caught) {
    if (!(caught instanceof SyncError && caught.code === "cancelled"))
      error.value = toUiError(caught);
  } finally {
    uploads.value = uploads.value.filter((u) => u.key !== item.key);
    report();
  }
}

/** Files go up one after another, in the order they were chosen. */
let queue: Promise<void> = Promise.resolve();

function add(files: FileList | null | undefined): void {
  error.value = undefined;
  for (const file of Array.from(files ?? [])) {
    if (model.value.length + uploads.value.length >= MAX_ATTACHMENTS) {
      error.value = { key: "too_many_attachments" };
      return;
    }
    if (limit.value !== undefined && file.size > limit.value) {
      error.value = { key: "sync_attachment_too_large" };
      continue;
    }
    const item = reactive<Upload>({
      key: next++,
      name: file.name,
      done: 0,
      total: file.size,
      controller: new AbortController(),
    });
    uploads.value.push(item);
    report();
    queue = queue.then(() => upload(file, item));
  }
}

function onFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  add(input.files);
  input.value = "";
}

function remove(id: string): void {
  model.value = model.value.filter((other) => other !== id);
}

onBeforeUnmount(() => {
  for (const item of uploads.value) item.controller.abort();
  // Saved ones are referenced by the entry now and stay.
  try {
    vaults
      .engine()
      .discardAttachments(props.vaultId, props.entryId, [...staged]);
  } catch {
    // Locked: the core dropped its staged uploads already.
  }
});
</script>

<template>
  <section class="attachments-tab" data-test="attachments-tab">
    <ul v-if="model.length > 0" class="attachment-list">
      <li
        v-for="id in model"
        :key="id"
        class="attachment-row"
        data-test="editor-attachment"
      >
        <span class="attachment-name" data-test="editor-attachment-name">{{
          infos.get(id)?.name || t("attachments.unnamed")
        }}</span>
        <span class="muted small-text">{{
          formatBytes(infos.get(id)?.size ?? 0)
        }}</span>
        <button
          type="button"
          class="icon-button"
          :aria-label="
            t('attachments.remove', { name: infos.get(id)?.name ?? '' })
          "
          data-test="editor-attachment-remove"
          @click="remove(id)"
        >
          <AppIcon ui="delete" />
        </button>
      </li>
    </ul>
    <p v-else-if="uploads.length === 0" class="muted">
      {{ t("attachments.none") }}
    </p>
    <ul v-if="uploads.length > 0" class="attachment-list">
      <li
        v-for="item in uploads"
        :key="item.key"
        class="attachment-row"
        data-test="attachment-upload"
      >
        <span class="attachment-name">{{ item.name }}</span>
        <progress
          :value="item.done"
          :max="Math.max(item.total, 1)"
          :aria-label="t('attachments.uploading', { name: item.name })"
        />
        <button
          type="button"
          class="small secondary"
          data-test="attachment-upload-cancel"
          @click="item.controller.abort()"
        >
          {{ t("common.cancel") }}
        </button>
      </li>
    </ul>
    <div
      class="drop-zone"
      data-test="attachments-drop"
      @dragover.prevent
      @drop.prevent="add($event.dataTransfer?.files)"
    >
      <label :for="inputId">{{ t("attachments.add") }}</label>
      <input
        :id="inputId"
        type="file"
        multiple
        data-test="attachments-file"
        @change="onFile"
      />
      <p class="muted small-text">
        {{
          limit === undefined
            ? t("attachments.hintNoLimit", { count: MAX_ATTACHMENTS })
            : t("attachments.hint", {
                size: formatBytes(limit),
                count: MAX_ATTACHMENTS,
              })
        }}
      </p>
    </div>
    <ErrorNotice :error="error" />
  </section>
</template>

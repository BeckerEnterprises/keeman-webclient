<script setup lang="ts">
/**
 * A code typed in, or read as a QR code from an image (chosen, dropped or
 * pasted); emits the text to check. Images are read here and go nowhere.
 */
import { ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import { imageOf, QrError, readQrCode } from "../../qr";

defineProps<{
  label: string;
  submit: string;
  busy?: boolean;
  /** Prefix of the test IDs. */
  test: string;
}>();
const model = defineModel<string>({ required: true });
const emit = defineEmits<{
  submit: [text: string];
  failure: [error: unknown];
}>();
const { t } = useI18n();
const ids = { code: useId(), file: useId() };
const reading = ref(false);
const readError = ref<string>();

async function readImage(image: Blob): Promise<void> {
  readError.value = undefined;
  reading.value = true;
  try {
    const text = await readQrCode(image);
    model.value = text;
    emit("submit", text);
  } catch (caught) {
    if (caught instanceof QrError)
      readError.value =
        caught.reason === "none" ? t("qrInput.noQr") : t("qrInput.badImage");
    else emit("failure", caught);
  } finally {
    reading.value = false;
  }
}

function onFile(event: Event): void {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  target.value = "";
  if (file) void readImage(file);
}

function onDrop(event: DragEvent): void {
  const image = imageOf(event.dataTransfer);
  if (image) void readImage(image);
}

/** Strg+V with an image; text pastes stay normal. */
function onPaste(event: ClipboardEvent): void {
  if (event.defaultPrevented) return;
  const image = imageOf(event.clipboardData);
  if (!image) return;
  event.preventDefault();
  void readImage(image);
}

defineExpose({ onPaste });
</script>

<template>
  <div class="qr-text-input" @paste="onPaste">
    <form
      class="inline-form"
      novalidate
      @submit.prevent="emit('submit', model)"
    >
      <label :for="ids.code">{{ label }}</label>
      <input
        :id="ids.code"
        v-model="model"
        type="text"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
        :data-test="`${test}-input`"
      />
      <button
        type="submit"
        :disabled="busy || model.trim() === ''"
        :data-test="`${test}-submit`"
      >
        {{ submit }}
      </button>
    </form>
    <div
      class="drop-zone"
      :data-test="`${test}-drop`"
      tabindex="0"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <label :for="ids.file">{{ t("qrInput.file") }}</label>
      <input
        :id="ids.file"
        type="file"
        accept="image/*"
        :data-test="`${test}-qr-file`"
        @change="onFile"
      />
      <p class="muted small-text">{{ t("qrInput.hint") }}</p>
      <p v-if="reading" aria-live="polite">{{ t("qrInput.reading") }}</p>
      <p v-if="readError" class="text-error">{{ readError }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Pairing devices of the account: this device shows a code for another
 * one, or takes over the marks of another device by its code (typed, or as
 * a QR code from an image). The code lives only in this page's state.
 */
import { computed, nextTick, onBeforeUnmount, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../../components/ErrorNotice.vue";
import { toUiError, type UiError } from "../../errors";
import { imageOf, QrError, readQrCode } from "../../qr";
import { drawQrCode } from "../../qr-code";
import { useServices } from "../../services";
import { useSessionStore } from "../../stores/session";

const { t } = useI18n();
const session = useSessionStore();
const ids = { code: useId(), file: useId() };

const busy = ref(false);
const error = ref<UiError>();
const shown = ref<{ code: string; expiresAt: number }>();
const qr = ref<HTMLCanvasElement>();
const now = ref(Date.now());
const ticker = setInterval(() => {
  now.value = Date.now();
}, 1000);
onBeforeUnmount(() => {
  clearInterval(ticker);
  shown.value = undefined;
  input.value = "";
});

const remaining = computed(() => {
  if (!shown.value) return 0;
  return Math.max(0, Math.ceil((shown.value.expiresAt - now.value) / 1000));
});
const countdown = computed(() => {
  const seconds = remaining.value;
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
});

async function show(): Promise<void> {
  busy.value = true;
  error.value = undefined;
  done.value = undefined;
  try {
    const pairing = await useServices().account.createPairing();
    shown.value = {
      code: pairing.code,
      expiresAt: Date.parse(pairing.expiresAt),
    };
    await nextTick();
    if (qr.value) await drawQrCode(qr.value, pairing.code.replaceAll(" ", ""));
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

const input = ref("");
const done = ref<number>();
const reading = ref(false);
const readError = ref<string>();

async function pair(code = input.value): Promise<void> {
  busy.value = true;
  error.value = undefined;
  done.value = undefined;
  try {
    done.value = await session.pair(code);
    input.value = "";
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

async function readImage(image: Blob): Promise<void> {
  readError.value = undefined;
  reading.value = true;
  try {
    const text = await readQrCode(image);
    input.value = text;
    await pair(text);
  } catch (caught) {
    if (caught instanceof QrError)
      readError.value =
        caught.reason === "none" ? t("pairing.noQr") : t("pairing.badImage");
    else error.value = toUiError(caught);
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

/** Strg+V with an image anywhere on the page; text pastes stay normal. */
function onPaste(event: ClipboardEvent): void {
  const image = imageOf(event.clipboardData);
  if (!image) return;
  event.preventDefault();
  void readImage(image);
}
</script>

<template>
  <section class="form" data-test="pairing" @paste="onPaste">
    <h2>{{ t("pairing.title") }}</h2>
    <p class="muted">{{ t("pairing.intro") }}</p>
    <p v-if="!session.freshness" class="notice notice-info">
      {{ t("error.sync_pairing_unsupported") }}
    </p>
    <ErrorNotice :error="error" />
    <template v-if="session.freshness">
      <section>
        <h3>{{ t("pairing.showTitle") }}</h3>
        <p class="muted">{{ t("pairing.showHint") }}</p>
        <div v-if="shown && remaining > 0" data-test="pairing-shown">
          <p class="mono secret-groups" data-test="pairing-code">
            {{ shown.code }}
          </p>
          <canvas ref="qr" class="qr-code" data-test="pairing-qr" />
          <p class="muted" aria-live="polite" data-test="pairing-countdown">
            {{ t("pairing.expiresIn", { time: countdown }) }}
          </p>
        </div>
        <p v-else-if="shown" class="notice notice-info">
          {{ t("pairing.expired") }}
        </p>
        <button
          type="button"
          :disabled="busy"
          data-test="pairing-show"
          @click="show"
        >
          {{ shown ? t("pairing.showAgain") : t("pairing.show") }}
        </button>
      </section>
      <section>
        <h3>{{ t("pairing.enterTitle") }}</h3>
        <p class="muted">{{ t("pairing.enterHint") }}</p>
        <form class="inline-form" novalidate @submit.prevent="pair()">
          <label :for="ids.code">{{ t("pairing.code") }}</label>
          <input
            :id="ids.code"
            v-model="input"
            type="text"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            data-test="pairing-input"
          />
          <button
            type="submit"
            :disabled="busy || input.trim() === ''"
            data-test="pairing-submit"
          >
            {{ t("pairing.submit") }}
          </button>
        </form>
        <div
          class="drop-zone"
          data-test="pairing-drop"
          tabindex="0"
          @dragover.prevent
          @drop.prevent="onDrop"
        >
          <label :for="ids.file">{{ t("pairing.qrFile") }}</label>
          <input
            :id="ids.file"
            type="file"
            accept="image/*"
            data-test="pairing-qr-file"
            @change="onFile"
          />
          <p class="muted small-text">{{ t("pairing.qrHint") }}</p>
          <p v-if="reading" aria-live="polite">{{ t("pairing.reading") }}</p>
          <p v-if="readError" class="text-error">{{ readError }}</p>
        </div>
        <p
          v-if="done !== undefined"
          class="notice notice-success"
          role="status"
          data-test="pairing-done"
        >
          {{ t("pairing.done", { count: done }) }}
        </p>
      </section>
    </template>
  </section>
</template>

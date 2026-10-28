<script setup lang="ts">
/**
 * Pairing devices of the account: this device shows a code for another
 * one, or takes over the marks of another device by its code (typed, or as
 * a QR code from an image). The code lives only in this page's state.
 */
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../../components/ErrorNotice.vue";
import QrTextInput from "../../components/ui/QrTextInput.vue";
import { toUiError, type UiError } from "../../errors";
import { drawQrCode } from "../../qr-code";
import { useServices } from "../../services";
import { useSessionStore } from "../../stores/session";

const { t } = useI18n();
const session = useSessionStore();

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
const entry = ref<InstanceType<typeof QrTextInput>>();

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

/** Strg+V with an image anywhere on the page; text pastes stay normal. */
function onPaste(event: ClipboardEvent): void {
  entry.value?.onPaste(event);
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
        <QrTextInput
          ref="entry"
          v-model="input"
          :label="t('pairing.code')"
          :submit="t('pairing.submit')"
          :busy="busy"
          test="pairing"
          @submit="pair"
          @failure="(caught) => (error = toUiError(caught))"
        />
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

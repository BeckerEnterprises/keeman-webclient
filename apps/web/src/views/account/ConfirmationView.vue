<script setup lang="ts">
/**
 * Having this device confirmed by another unlocked device of the account:
 * ask, wait with the remaining time, and the result.
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../../components/ErrorNotice.vue";
import { useConfirmationStore } from "../../stores/confirmation";
import { useSessionStore } from "../../stores/session";

const { t } = useI18n();
const session = useSessionStore();
const confirmation = useConfirmationStore();
const busy = ref(false);

const now = ref(Date.now());
const ticker = setInterval(() => {
  now.value = Date.now();
}, 1000);
onBeforeUnmount(() => {
  clearInterval(ticker);
});

const own = computed(() => confirmation.own);
const countdown = computed(() => {
  const request = own.value;
  if (request?.status !== "waiting") return "";
  const seconds = Math.max(
    0,
    Math.ceil((request.expiresAt - now.value) / 1000),
  );
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
});

async function ask(): Promise<void> {
  busy.value = true;
  try {
    await confirmation.request();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="form" data-test="confirmation">
    <h2>{{ t("confirmation.title") }}</h2>
    <p class="muted">{{ t("confirmation.intro") }}</p>
    <p v-if="!session.confirmation" class="notice notice-info">
      {{ t("error.sync_confirmation_unsupported") }}
    </p>
    <template v-else>
      <div
        v-if="own?.status === 'waiting'"
        class="notice notice-info"
        aria-live="polite"
        data-test="confirmation-waiting"
      >
        <p>{{ t("confirmation.waiting") }}</p>
        <p class="muted" data-test="confirmation-countdown">
          {{ t("confirmation.expiresIn", { time: countdown }) }}
        </p>
        <div class="actions">
          <button
            type="button"
            class="small secondary"
            data-test="confirmation-cancel"
            @click="confirmation.cancel()"
          >
            {{ t("confirmation.cancel") }}
          </button>
        </div>
      </div>
      <template v-else>
        <div
          v-if="own?.status === 'confirmed'"
          class="notice notice-success"
          role="status"
          data-test="confirmation-done"
        >
          <p>
            {{
              t("confirmation.done", {
                confirmed: own.confirmed,
                vaults: own.vaults,
              })
            }}
          </p>
          <p v-if="own.confirmed < own.vaults">
            {{ t("confirmation.partly") }}
          </p>
          <p v-if="own.missing > 0" data-test="confirmation-missing">
            {{ t("confirmation.missing", { count: own.missing }) }}
          </p>
        </div>
        <ErrorNotice
          v-if="own?.status === 'failed'"
          :error="own.error"
          data-test="confirmation-failed"
        />
        <button
          type="button"
          :disabled="busy"
          data-test="confirmation-request"
          @click="ask"
        >
          {{ own ? t("confirmation.requestAgain") : t("confirmation.request") }}
        </button>
      </template>
    </template>
  </section>
</template>

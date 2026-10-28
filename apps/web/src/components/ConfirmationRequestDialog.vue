<script setup lang="ts">
/**
 * Another device of the account asks to take over this device's state.
 * Nothing is confirmed without a click; "That wasn't me" leads to the
 * sessions, because the asking device knows the master password.
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { toUiError, type UiError } from "../errors";
import { formatDate } from "../format";
import { useServices } from "../services";
import { useConfirmationStore } from "../stores/confirmation";
import ErrorNotice from "./ErrorNotice.vue";
import AppDialog from "./ui/AppDialog.vue";

const i18n = useI18n();
const { t } = i18n;
const router = useRouter();
const confirmation = useConfirmationStore();
const busy = ref(false);
const error = ref<UiError>();
const accepted = ref(false);

const now = ref(Date.now());
const ticker = setInterval(() => {
  now.value = Date.now();
}, 1000);
onBeforeUnmount(() => {
  clearInterval(ticker);
});

const request = computed(() => {
  const shown = confirmation.shown;
  return shown && shown.expiresAt > now.value ? shown : undefined;
});
const left = computed(() => {
  const seconds = Math.max(
    0,
    Math.ceil(((request.value?.expiresAt ?? 0) - now.value) / 1000),
  );
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
});
const type = computed(() => {
  const client = request.value?.clientType ?? "";
  const key = `confirmation.client.${client}`;
  return i18n.te(key) ? t(key) : client;
});
const unconfirmed = computed(() =>
  request.value ? useServices().account.unconfirmableVaults : 0,
);

async function accept(): Promise<void> {
  if (!request.value) return;
  busy.value = true;
  error.value = undefined;
  try {
    await confirmation.confirm(request.value.requestId);
    accepted.value = true;
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

async function decline(): Promise<void> {
  if (!request.value) return;
  busy.value = true;
  error.value = undefined;
  try {
    await confirmation.decline(request.value);
    await router.push("/account/sessions");
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

function later(): void {
  if (request.value) confirmation.later(request.value.requestId);
  error.value = undefined;
}
</script>

<template>
  <AppDialog
    v-if="accepted"
    :title="t('confirmation.incomingTitle')"
    data-test="confirmation-incoming"
    @close="accepted = false"
  >
    <p class="notice notice-success" role="status">
      {{ t("confirmation.accepted") }}
    </p>
    <template #actions>
      <button
        type="button"
        data-test="confirmation-incoming-close"
        @click="accepted = false"
      >
        {{ t("common.close") }}
      </button>
    </template>
  </AppDialog>
  <AppDialog
    v-else-if="request"
    :title="t('confirmation.incomingTitle')"
    data-test="confirmation-incoming"
    @close="later"
  >
    <p data-test="confirmation-incoming-device">
      {{
        t("confirmation.incomingDevice", {
          name: request.deviceName,
          type,
        })
      }}
    </p>
    <p class="muted">
      {{
        t("confirmation.incomingTime", {
          time: formatDate(request.created),
          left,
        })
      }}
    </p>
    <p>{{ t("confirmation.incomingHint") }}</p>
    <p
      v-if="unconfirmed > 0"
      class="notice notice-warning"
      data-test="confirmation-incoming-unconfirmed"
    >
      {{ t("confirmation.incomingUnconfirmed", { count: unconfirmed }) }}
    </p>
    <ErrorNotice :error="error" />
    <template #actions>
      <button
        type="button"
        :disabled="busy"
        data-test="confirmation-accept"
        @click="accept"
      >
        {{ t("confirmation.accept") }}
      </button>
      <button
        type="button"
        class="danger"
        :disabled="busy"
        data-test="confirmation-decline"
        @click="decline"
      >
        {{ t("confirmation.decline") }}
      </button>
      <!-- Focused first: a stray Enter must not confirm another device. -->
      <button
        type="button"
        class="secondary"
        :disabled="busy"
        autofocus
        data-test="confirmation-later"
        @click="later"
      >
        {{ t("confirmation.later") }}
      </button>
    </template>
  </AppDialog>
</template>

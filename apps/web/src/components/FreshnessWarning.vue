<script setup lang="ts">
/**
 * No device of the account confirmed the delivered state of a database
 * within the period: it stays read-only until another device confirms this
 * one or the user confirms the state, after asking.
 */
import type { VaultView } from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { toUiError, type UiError } from "../errors";
import { formatDate } from "../format";
import { useConfirmationStore } from "../stores/confirmation";
import { useSessionStore } from "../stores/session";
import { useVaultsStore } from "../stores/vaults";
import ErrorNotice from "./ErrorNotice.vue";
import ConfirmDialog from "./dialogs/ConfirmDialog.vue";

const props = defineProps<{ vault: VaultView }>();
const { t } = useI18n();
const session = useSessionStore();
const vaults = useVaultsStore();
const busy = ref(false);
const asking = ref(false);
const error = ref<UiError>();
const router = useRouter();
const confirmation = useConfirmationStore();

/** Asks the other devices of the account and shows the waiting page. */
async function askConfirmation(): Promise<void> {
  await confirmation.request();
  await router.push("/account/confirm");
}

const since = computed(() =>
  props.vault.confirmedSince === undefined
    ? undefined
    : formatDate(new Date(props.vault.confirmedSince).toISOString()),
);

async function acknowledge(): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    await vaults.engine().acknowledgeFreshness(props.vault.id);
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
    asking.value = false;
  }
}
</script>

<template>
  <div
    v-if="vault.freshness === 'stale'"
    class="notice notice-warning"
    data-test="vault-freshness"
  >
    <p>
      {{
        since
          ? t("freshness.vaultSince", { date: since })
          : t("freshness.vaultNever")
      }}
    </p>
    <p>{{ t("freshness.vaultReadOnly") }}</p>
    <div class="actions">
      <button
        v-if="session.confirmation"
        type="button"
        class="small"
        data-test="vault-freshness-confirm"
        @click="askConfirmation"
      >
        {{ t("freshness.confirm") }}
      </button>
      <button
        type="button"
        class="small"
        :disabled="busy"
        data-test="vault-freshness-ack"
        @click="asking = true"
      >
        {{ t("common.understood") }}
      </button>
    </div>
  </div>
  <ErrorNotice :error="error" />
  <ConfirmDialog
    v-if="asking"
    :title="t('freshness.ackTitle')"
    :text="t('freshness.ackText')"
    :confirm="t('common.understood')"
    danger
    :busy="busy"
    @confirm="acknowledge"
    @close="asking = false"
  />
</template>

<script setup lang="ts">
import { CLOCK_SKEW_HINT_MS } from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../errors";
import { formatDate } from "../format";
import { useSessionStore } from "../stores/session";
import { useVaultsStore } from "../stores/vaults";
import ErrorNotice from "./ErrorNotice.vue";
import ConfirmDialog from "./dialogs/ConfirmDialog.vue";
import SharingBanners from "./sharing/SharingBanners.vue";

const { t } = useI18n();
const session = useSessionStore();
const vaults = useVaultsStore();
/** TOTP codes follow the server time; a large difference is pointed out. */
const clockSkewed = computed(
  () => Math.abs(vaults.snapshot?.clockOffset ?? 0) > CLOCK_SKEW_HINT_MS,
);

/** Databases and account data no device of the account confirmed in time. */
const stale = computed(() => {
  const vaultsStale = vaults.vaults.filter((v) => v.freshness === "stale");
  const times = vaultsStale
    .map((v) => v.confirmedSince)
    .filter((at): at is number => at !== undefined);
  if (session.banners.userDataConfirmedSince !== undefined)
    times.push(session.banners.userDataConfirmedSince);
  if (vaultsStale.length === 0 && !session.banners.userDataStale)
    return undefined;
  return {
    count: vaultsStale.length,
    since:
      times.length > 0
        ? formatDate(new Date(Math.max(...times)).toISOString())
        : undefined,
  };
});
const confirming = ref(false);
const confirmBusy = ref(false);
const confirmError = ref<UiError>();

async function acknowledgeFreshness(): Promise<void> {
  confirmBusy.value = true;
  confirmError.value = undefined;
  try {
    await session.acknowledgeFreshness();
  } catch (caught) {
    confirmError.value = toUiError(caught);
  } finally {
    confirmBusy.value = false;
    confirming.value = false;
  }
}

async function acknowledgeUserData(): Promise<void> {
  await session.acknowledgeUserDataRollback().catch(() => undefined);
}

function reload(): void {
  window.location.reload();
}
</script>

<template>
  <div class="banners">
    <p v-if="session.preloadFailed" class="notice notice-info">
      {{ t("banner.preload") }}
      <button type="button" class="small" @click="reload">
        {{ t("common.reload") }}
      </button>
    </p>
    <p
      v-if="session.notice === 'logoutFailed'"
      class="notice notice-error"
      role="alert"
    >
      {{ t("banner.logoutFailed") }}
    </p>
    <template
      v-if="session.phase === 'unlocked' && !session.confirmingRecoveryKey"
    >
      <p
        v-if="session.banners.recoveryKeyUnconfirmed"
        class="notice notice-warning"
        data-test="banner-recovery"
      >
        {{ t("banner.recoveryKey") }}
        <RouterLink to="/account/recovery-key">{{
          t("banner.recoveryKeyAction")
        }}</RouterLink>
      </p>
      <p
        v-if="session.banners.recovered"
        class="notice notice-success"
        role="status"
        data-test="banner-recovered"
      >
        {{ t("banner.recovered") }}
        <button
          type="button"
          class="small"
          @click="session.banners.recovered = false"
        >
          {{ t("common.understood") }}
        </button>
      </p>
      <p
        v-if="session.banners.backupCodesRemaining !== undefined"
        class="notice"
        :class="
          session.banners.backupCodesRemaining === 0
            ? 'notice-warning'
            : 'notice-info'
        "
        data-test="banner-backup-codes"
      >
        {{
          session.banners.backupCodesRemaining === 0
            ? t("banner.backupCodesNone")
            : t("banner.backupCodesLeft", {
                count: session.banners.backupCodesRemaining,
              })
        }}
        <RouterLink
          v-if="session.banners.backupCodesRemaining <= 3"
          to="/account/two-factor"
          >{{ t("banner.backupCodesAction") }}</RouterLink
        >
        <button
          type="button"
          class="small"
          @click="session.banners.backupCodesRemaining = undefined"
        >
          {{ t("common.understood") }}
        </button>
      </p>
      <p v-if="clockSkewed" class="notice notice-info" data-test="banner-clock">
        {{ t("banner.clockSkew") }}
      </p>
      <p
        v-if="session.banners.kdfBelowDefault"
        class="notice notice-warning"
        data-test="banner-kdf"
      >
        {{ t("banner.kdfBelowDefault") }}
        <RouterLink to="/account/kdf">{{ t("banner.kdfAction") }}</RouterLink>
      </p>
      <p v-if="session.banners.userDataCorrupt" class="notice notice-error">
        {{ t("banner.userDataCorrupt") }}
      </p>
      <p
        v-if="session.banners.userDataRollback"
        class="notice notice-error"
        role="alert"
        data-test="banner-user-data-rollback"
      >
        {{ t("banner.userDataRollback") }}
        <button type="button" class="small" @click="acknowledgeUserData">
          {{ t("common.understood") }}
        </button>
      </p>
      <div
        v-if="stale"
        class="notice notice-warning"
        role="alert"
        data-test="banner-freshness"
      >
        <p>
          {{
            stale.since
              ? t("freshness.bannerSince", { date: stale.since })
              : t("freshness.bannerNever")
          }}
        </p>
        <p>{{ t("freshness.bannerReadOnly") }}</p>
        <div class="actions">
          <RouterLink v-if="session.freshness" to="/account/pairing">{{
            t("freshness.pair")
          }}</RouterLink>
          <button
            type="button"
            class="small"
            :disabled="confirmBusy"
            data-test="banner-freshness-ack"
            @click="confirming = true"
          >
            {{ t("common.understood") }}
          </button>
        </div>
      </div>
      <ErrorNotice :error="confirmError" />
      <p
        v-if="!stale && session.banners.newDevice && session.freshness"
        class="notice notice-info"
        data-test="banner-new-device"
      >
        {{ t("freshness.newDevice") }}
        <RouterLink to="/account/pairing">{{ t("freshness.pair") }}</RouterLink>
        <button
          type="button"
          class="small secondary"
          @click="session.banners.newDevice = false"
        >
          {{ t("freshness.later") }}
        </button>
      </p>
      <SharingBanners />
      <p
        v-if="vaults.snapshot?.marksLimited"
        class="notice notice-warning"
        data-test="banner-marks-limited"
      >
        {{ t("banner.marksLimited") }}
      </p>
    </template>
    <ConfirmDialog
      v-if="confirming"
      :title="t('freshness.ackTitle')"
      :text="t('freshness.ackText')"
      :confirm="t('common.understood')"
      danger
      :busy="confirmBusy"
      @confirm="acknowledgeFreshness"
      @close="confirming = false"
    />
  </div>
</template>

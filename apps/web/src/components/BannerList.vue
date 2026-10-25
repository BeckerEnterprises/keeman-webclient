<script setup lang="ts">
import { CLOCK_SKEW_HINT_MS } from "@keeman/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useSessionStore } from "../stores/session";
import { useVaultsStore } from "../stores/vaults";
import SharingBanners from "./sharing/SharingBanners.vue";

const { t } = useI18n();
const session = useSessionStore();
const vaults = useVaultsStore();
/** TOTP codes follow the server time; a large difference is pointed out. */
const clockSkewed = computed(
  () => Math.abs(vaults.snapshot?.clockOffset ?? 0) > CLOCK_SKEW_HINT_MS,
);

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
      <SharingBanners />
      <p
        v-if="vaults.snapshot?.marksLimited"
        class="notice notice-warning"
        data-test="banner-marks-limited"
      >
        {{ t("banner.marksLimited") }}
      </p>
    </template>
  </div>
</template>

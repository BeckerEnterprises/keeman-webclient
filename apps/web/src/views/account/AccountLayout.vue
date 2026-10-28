<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useSessionStore } from "../../stores/session";

const { t } = useI18n();
const session = useSessionStore();
const all = [
  "password",
  "kdf",
  "recovery-key",
  "two-factor",
  "sessions",
  "contacts",
  "confirm",
  "settings",
  "about",
  "delete",
] as const;
// Confirmations need a server that stores them.
const sections = computed(() =>
  all.filter((section) => section !== "confirm" || session.confirmation),
);
const labels: Record<(typeof all)[number], string> = {
  password: "account.password",
  kdf: "account.kdf",
  "recovery-key": "account.recovery",
  "two-factor": "account.twoFactor",
  sessions: "account.sessions",
  contacts: "account.contacts",
  confirm: "account.confirm",
  settings: "account.settings",
  about: "account.about",
  delete: "account.delete",
};
</script>

<template>
  <div class="account">
    <h1>{{ t("account.title") }}</h1>
    <div class="account-grid">
      <nav :aria-label="t('account.nav')" class="account-nav">
        <RouterLink
          v-for="section in sections"
          :key="section"
          :to="`/account/${section}`"
        >
          {{ t(labels[section]) }}
        </RouterLink>
      </nav>
      <div class="account-content">
        <RouterView />
      </div>
    </div>
  </div>
</template>

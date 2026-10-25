<script setup lang="ts">
import { useI18n } from "vue-i18n";

const { t } = useI18n();
const sections = [
  "password",
  "kdf",
  "recovery-key",
  "two-factor",
  "sessions",
  "contacts",
  "settings",
  "about",
  "delete",
] as const;
const labels: Record<(typeof sections)[number], string> = {
  password: "account.password",
  kdf: "account.kdf",
  "recovery-key": "account.recovery",
  "two-factor": "account.twoFactor",
  sessions: "account.sessions",
  contacts: "account.contacts",
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

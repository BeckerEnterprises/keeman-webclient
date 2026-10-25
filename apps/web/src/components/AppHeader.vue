<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useSessionStore } from "../stores/session";

const { t } = useI18n();
const session = useSessionStore();

async function logout(): Promise<void> {
  await session.logout().catch(() => undefined);
}
</script>

<template>
  <header class="header">
    <RouterLink to="/vaults" class="brand">{{ t("app.name") }}</RouterLink>
    <nav :aria-label="t('nav.main')" class="header-nav">
      <RouterLink to="/vaults" data-test="nav-entries">{{
        t("nav.entries")
      }}</RouterLink>
      <RouterLink to="/databases" data-test="nav-databases">{{
        t("nav.home")
      }}</RouterLink>
      <RouterLink to="/account">{{ t("nav.account") }}</RouterLink>
    </nav>
    <div class="header-actions">
      <span class="header-email">{{ session.email }}</span>
      <button type="button" data-test="lock" @click="session.lock()">
        {{ t("nav.lock") }}
      </button>
      <button
        type="button"
        class="secondary"
        data-test="logout"
        @click="logout"
      >
        {{ t("nav.logout") }}
      </button>
    </div>
  </header>
</template>

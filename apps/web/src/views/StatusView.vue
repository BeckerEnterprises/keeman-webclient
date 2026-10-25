<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import AppFooter from "../components/AppFooter.vue";
import { useSessionStore } from "../stores/session";

const { t } = useI18n();
const session = useSessionStore();

const texts = computed(() => {
  switch (session.fatal) {
    case "unreachable":
      return {
        title: t("start.unreachableTitle"),
        text: t("start.unreachableText"),
      };
    case "config":
      return { title: t("start.configTitle"), text: t("start.configText") };
    case "forbidden":
      return {
        title: t("start.forbiddenTitle"),
        text: t("start.forbiddenText"),
      };
    case "version":
      return { title: t("start.versionTitle"), text: t("start.versionText") };
    case "crypto":
      return { title: t("start.cryptoTitle"), text: t("start.cryptoText") };
    case "integrity":
      return {
        title: t("start.integrityTitle"),
        text: t("start.integrityText"),
      };
    default:
      return undefined;
  }
});

function retry(): void {
  if (session.fatal === "integrity") session.phase = "loggedOut";
  else void session.start();
}
</script>

<template>
  <div class="layout">
    <main id="main" class="content narrow" data-test="status">
      <h1>{{ t("app.name") }}</h1>
      <p v-if="session.phase === 'starting'" aria-live="polite">
        {{ t("start.loading") }}
      </p>
      <section v-else-if="texts" class="notice notice-error" role="alert">
        <h2>{{ texts.title }}</h2>
        <p>{{ texts.text }}</p>
        <button
          v-if="
            session.fatal === 'unreachable' || session.fatal === 'integrity'
          "
          type="button"
          @click="retry"
        >
          {{
            session.fatal === "integrity"
              ? t("start.toLogin")
              : t("common.retry")
          }}
        </button>
      </section>
    </main>
    <AppFooter />
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { APP_COMMIT, APP_VERSION, SOURCE_URLS } from "../../build-info";

const { t } = useI18n();
</script>

<template>
  <section data-test="about">
    <h2>{{ t("about.title") }}</h2>
    <p>{{ t("about.text") }}</p>
    <p data-test="about-version">
      {{ t("about.version", { version: APP_VERSION, commit: APP_COMMIT }) }}
    </p>
    <ul>
      <li>
        <a
          :href="SOURCE_URLS.webclient"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ t("footer.source") }} – {{ t("footer.webclient") }}
        </a>
      </li>
      <li>
        <a :href="SOURCE_URLS.server" target="_blank" rel="noopener noreferrer">
          {{ t("footer.source") }} – {{ t("footer.server") }}
        </a>
      </li>
    </ul>
    <h3>{{ t("about.thirdParty") }}</h3>
    <ul class="small-text" data-test="about-third-party">
      <li>{{ t("about.lucide") }}</li>
      <li>{{ t("about.eff") }}</li>
      <li>{{ t("about.kdbx") }}</li>
      <li>{{ t("about.jsqr") }}</li>
      <li>{{ t("about.qrcode") }}</li>
    </ul>
  </section>
</template>

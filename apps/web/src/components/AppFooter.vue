<script setup lang="ts">
import { LANGUAGES, type Language } from "@keeman/core";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { SOURCE_URLS } from "../build-info";
import { currentLocale, setLocale } from "../i18n";
import { loadTheme, type Theme } from "../storage";
import { setTheme } from "../theme";

const { t } = useI18n();
const theme = ref<Theme>(loadTheme());
const locale = ref<Language>(currentLocale());

function changeTheme(): void {
  setTheme(theme.value);
}

function changeLocale(): void {
  setLocale(locale.value);
}
</script>

<template>
  <footer class="footer">
    <p class="footer-source">
      {{ t("footer.source") }}:
      <a
        :href="SOURCE_URLS.webclient"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ t("footer.webclient") }}
      </a>
      ·
      <a :href="SOURCE_URLS.server" target="_blank" rel="noopener noreferrer">
        {{ t("footer.server") }}
      </a>
    </p>
    <div class="footer-prefs">
      <label>
        {{ t("theme.label") }}
        <select v-model="theme" data-test="theme" @change="changeTheme">
          <option value="system">{{ t("theme.system") }}</option>
          <option value="light">{{ t("theme.light") }}</option>
          <option value="dark">{{ t("theme.dark") }}</option>
        </select>
      </label>
      <label>
        {{ t("language.label") }}
        <select v-model="locale" data-test="locale" @change="changeLocale">
          <option
            v-for="language in LANGUAGES"
            :key="language"
            :value="language"
          >
            {{ t(`language.${language}`) }}
          </option>
        </select>
      </label>
    </div>
  </footer>
</template>

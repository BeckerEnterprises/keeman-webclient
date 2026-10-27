<script setup lang="ts">
/** Settings in user_data.settings. */
import {
  FORBIDDEN_SCHEMES,
  isUrlSchemeList,
  LANGUAGES,
  type Language,
  type SettingsChange,
} from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../../components/ErrorNotice.vue";
import { toUiError, type UiError } from "../../errors";
import { currentLocale } from "../../i18n";
import { useSessionStore } from "../../stores/session";

const { t } = useI18n();
const session = useSessionStore();
const autoLock = ref(session.settings.autoLockMinutes);
const freshnessDays = ref(session.settings.freshnessDays);
const hiddenMode = ref<"off" | "now" | "after">(
  session.settings.lockOnHiddenMinutes === null
    ? "off"
    : session.settings.lockOnHiddenMinutes === 0
      ? "now"
      : "after",
);
const hiddenMinutes = ref(session.settings.lockOnHiddenMinutes || 5);
const clipboardMode = ref<"off" | "after">(
  session.settings.clipboardClearSeconds === null ? "off" : "after",
);
const clipboardSeconds = ref(session.settings.clipboardClearSeconds ?? 30);
const searchProtected = ref(session.settings.searchProtectedFields);
const showTotp = ref(session.settings.showTotpColumn);
const schemesText = ref(session.settings.allowedUrlSchemes.join(", "));
/** Comma-separated, without regard to case. */
const schemes = computed(() =>
  schemesText.value
    .split(",")
    .map((scheme) => scheme.trim().toLowerCase())
    .filter((scheme) => scheme !== ""),
);
const schemesValid = computed(() => isUrlSchemeList(schemes.value));
const forbidden = FORBIDDEN_SCHEMES.join(", ");
const language = ref<Language | "device">(
  session.settings.language ?? "device",
);
const resetWord = ref("");
const busy = ref(false);
const saved = ref(false);
const error = ref<UiError>();

const readOnly = computed(
  () => session.banners.userDataCorrupt || session.banners.userDataReadOnly,
);

function isMinutes(value: number, min: number): boolean {
  return Number.isInteger(value) && value >= min && value <= 1440;
}

const valid = computed(
  () =>
    isMinutes(autoLock.value, 1) &&
    Number.isInteger(freshnessDays.value) &&
    freshnessDays.value >= 1 &&
    freshnessDays.value <= 90 &&
    (hiddenMode.value !== "after" || isMinutes(hiddenMinutes.value, 1)) &&
    (clipboardMode.value === "off" ||
      (Number.isInteger(clipboardSeconds.value) &&
        clipboardSeconds.value >= 5 &&
        clipboardSeconds.value <= 600)) &&
    schemesValid.value,
);

/** Values as loaded; only what the user changed is written. */
const initial = {
  autoLockMinutes: session.settings.autoLockMinutes,
  freshnessDays: session.settings.freshnessDays,
  lockOnHiddenMinutes: session.settings.lockOnHiddenMinutes,
  language: session.settings.language,
  clipboardClearSeconds: session.settings.clipboardClearSeconds,
  searchProtectedFields: session.settings.searchProtectedFields,
  showTotpColumn: session.settings.showTotpColumn,
  allowedUrlSchemes: session.settings.allowedUrlSchemes,
};

async function save(): Promise<void> {
  if (!valid.value) return;
  const lockOnHidden =
    hiddenMode.value === "off"
      ? null
      : hiddenMode.value === "now"
        ? 0
        : hiddenMinutes.value;
  const chosenLanguage =
    language.value === "device" ? undefined : language.value;
  const change: SettingsChange = {};
  if (autoLock.value !== initial.autoLockMinutes)
    change.autoLockMinutes = autoLock.value;
  if (freshnessDays.value !== initial.freshnessDays)
    change.freshnessDays = freshnessDays.value;
  if (lockOnHidden !== initial.lockOnHiddenMinutes)
    change.lockOnHiddenMinutes = lockOnHidden;
  if (chosenLanguage !== initial.language) change.language = chosenLanguage;
  const clipboard =
    clipboardMode.value === "off" ? null : clipboardSeconds.value;
  if (clipboard !== initial.clipboardClearSeconds)
    change.clipboardClearSeconds = clipboard;
  if (searchProtected.value !== initial.searchProtectedFields)
    change.searchProtectedFields = searchProtected.value;
  if (showTotp.value !== initial.showTotpColumn)
    change.showTotpColumn = showTotp.value;
  const allowed = schemes.value;
  if (allowed.join(",") !== initial.allowedUrlSchemes.join(","))
    change.allowedUrlSchemes = allowed;
  busy.value = true;
  saved.value = false;
  error.value = undefined;
  try {
    if (Object.keys(change).length > 0) await session.updateSettings(change);
    initial.autoLockMinutes = autoLock.value;
    initial.freshnessDays = freshnessDays.value;
    initial.lockOnHiddenMinutes = lockOnHidden;
    initial.language = chosenLanguage;
    initial.clipboardClearSeconds = clipboard;
    initial.searchProtectedFields = searchProtected.value;
    initial.showTotpColumn = showTotp.value;
    initial.allowedUrlSchemes = allowed;
    schemesText.value = allowed.join(", ");
    saved.value = true;
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

async function reset(): Promise<void> {
  if (resetWord.value !== t("settings.resetWord")) return;
  busy.value = true;
  error.value = undefined;
  try {
    await session.resetUserData(currentLocale());
    resetWord.value = "";
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section data-test="settings">
    <h2>{{ t("settings.title") }}</h2>
    <p v-if="session.banners.userDataCorrupt" class="notice notice-error">
      {{ t("settings.corrupt") }}
    </p>
    <p
      v-else-if="session.banners.userDataStale"
      class="notice notice-warning"
      data-test="settings-stale"
    >
      {{ t("settings.stale") }}
    </p>
    <p
      v-else-if="session.banners.userDataReadOnly"
      class="notice notice-warning"
    >
      {{ t("settings.readOnly") }}
    </p>
    <form class="form" @submit.prevent="save">
      <fieldset :disabled="readOnly || busy" class="plain">
        <div class="field">
          <label for="settings-autolock">{{ t("settings.autoLock") }}</label>
          <input
            id="settings-autolock"
            v-model.number="autoLock"
            type="number"
            min="1"
            max="1440"
            step="1"
            required
            data-test="settings-autolock"
          />
        </div>
        <div class="field">
          <label for="settings-freshness">{{ t("settings.freshness") }}</label>
          <input
            id="settings-freshness"
            v-model.number="freshnessDays"
            type="number"
            min="1"
            max="90"
            step="1"
            required
            aria-describedby="settings-freshness-hint"
            data-test="settings-freshness"
          />
          <p id="settings-freshness-hint" class="muted small-text">
            {{ t("settings.freshnessHint") }}
          </p>
        </div>
        <fieldset>
          <legend>{{ t("settings.lockOnHidden") }}</legend>
          <label class="choice"
            ><input v-model="hiddenMode" type="radio" value="off" />
            {{ t("settings.lockOnHiddenOff") }}</label
          >
          <label class="choice"
            ><input v-model="hiddenMode" type="radio" value="now" />
            {{ t("settings.lockOnHiddenNow") }}</label
          >
          <label class="choice"
            ><input v-model="hiddenMode" type="radio" value="after" />
            {{ t("settings.lockOnHiddenAfter") }}</label
          >
          <div v-if="hiddenMode === 'after'" class="field">
            <label for="settings-hidden">{{
              t("settings.lockOnHiddenMinutes")
            }}</label>
            <input
              id="settings-hidden"
              v-model.number="hiddenMinutes"
              type="number"
              min="1"
              max="1440"
              step="1"
            />
          </div>
        </fieldset>
        <div class="field">
          <label for="settings-language">{{ t("settings.language") }}</label>
          <select
            id="settings-language"
            v-model="language"
            data-test="settings-language"
          >
            <option value="device">{{ t("settings.languageDevice") }}</option>
            <option v-for="item in LANGUAGES" :key="item" :value="item">
              {{ t(`language.${item}`) }}
            </option>
          </select>
        </div>
        <fieldset>
          <legend>{{ t("settings.clipboard") }}</legend>
          <label class="choice"
            ><input
              v-model="clipboardMode"
              type="radio"
              value="off"
              data-test="settings-clipboard-off"
            />
            {{ t("settings.clipboardOff") }}</label
          >
          <label class="choice"
            ><input v-model="clipboardMode" type="radio" value="after" />
            {{ t("settings.clipboardAfter") }}</label
          >
          <div v-if="clipboardMode === 'after'" class="field">
            <label for="settings-clipboard">{{
              t("settings.clipboardSeconds")
            }}</label>
            <input
              id="settings-clipboard"
              v-model.number="clipboardSeconds"
              type="number"
              min="5"
              max="600"
              step="1"
              data-test="settings-clipboard"
            />
          </div>
        </fieldset>
        <label class="choice">
          <input
            v-model="searchProtected"
            type="checkbox"
            data-test="settings-search-protected"
          />
          {{ t("settings.searchProtected") }}
        </label>
        <label class="choice">
          <input
            v-model="showTotp"
            type="checkbox"
            data-test="settings-show-totp"
          />
          {{ t("settings.showTotpColumn") }}
        </label>
        <div class="field">
          <label for="settings-url-schemes">{{
            t("settings.urlSchemes")
          }}</label>
          <input
            id="settings-url-schemes"
            v-model="schemesText"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="settings-url-schemes-hint"
            :aria-invalid="!schemesValid"
            data-test="settings-url-schemes"
          />
          <p
            id="settings-url-schemes-hint"
            class="small-text"
            :class="schemesValid ? 'muted' : 'text-error'"
            data-test="settings-url-schemes-hint"
          >
            {{
              schemesValid
                ? t("settings.urlSchemesHint", { names: forbidden })
                : t("settings.urlSchemesInvalid", { names: forbidden })
            }}
          </p>
        </div>
        <p class="muted small-text">{{ t("settings.generatorHint") }}</p>
        <ErrorNotice :error="error" />
        <p v-if="saved" class="notice notice-success" role="status">
          {{ t("settings.saved") }}
        </p>
        <button type="submit" :disabled="!valid" data-test="settings-save">
          {{ t("common.save") }}
        </button>
      </fieldset>
    </form>
    <form
      v-if="session.banners.userDataCorrupt"
      class="form"
      @submit.prevent="reset"
    >
      <div class="field">
        <label for="settings-reset">{{ t("settings.resetConfirm") }}</label>
        <input id="settings-reset" v-model="resetWord" autocomplete="off" />
      </div>
      <button
        type="submit"
        class="danger"
        :disabled="busy || resetWord !== t('settings.resetWord')"
      >
        {{ t("settings.reset") }}
      </button>
    </form>
  </section>
</template>

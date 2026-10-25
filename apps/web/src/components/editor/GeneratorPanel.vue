<script setup lang="ts">
/**
 * Password generator: characters or EFF passphrase, entropy in bits,
 * a warning below 12 characters, "save as default" into user_data.
 */
import {
  GENERATOR_LIMITS,
  generateSecret,
  secretBits,
  type GeneratorOptions,
} from "@keeman/core";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../../errors";
import { useSessionStore } from "../../stores/session";
import ErrorNotice from "../ErrorNotice.vue";
import AppIcon from "../ui/AppIcon";

const emit = defineEmits<{ use: [value: string]; close: [] }>();
const { t } = useI18n();
const session = useSessionStore();
const options = ref<GeneratorOptions>({
  ...session.settings.passwordGenerator,
});
const value = ref("");
const saved = ref(false);
const error = ref<UiError>();

const bits = computed(() => Math.floor(secretBits(options.value)));
const short = computed(
  () =>
    options.value.mode === "chars" &&
    options.value.length < GENERATOR_LIMITS.warnLength,
);
const valid = computed(() => {
  const o = options.value;
  const classes = [o.upper, o.lower, o.digits, o.symbols].filter(
    Boolean,
  ).length;
  return o.mode === "words"
    ? o.words >= GENERATOR_LIMITS.minWords &&
        o.words <= GENERATOR_LIMITS.maxWords &&
        Array.from(o.separator).length <= GENERATOR_LIMITS.maxSeparator
    : classes > 0 &&
        o.length >= Math.max(GENERATOR_LIMITS.minLength, classes) &&
        o.length <= GENERATOR_LIMITS.maxLength;
});

async function generate(): Promise<void> {
  if (!valid.value) return;
  value.value = await generateSecret({ ...options.value });
}

async function saveDefault(): Promise<void> {
  error.value = undefined;
  try {
    await session.updateSettings({ passwordGenerator: { ...options.value } });
    saved.value = true;
  } catch (caught) {
    error.value = toUiError(caught);
  }
}

watch(
  options,
  () => {
    saved.value = false;
    void generate();
  },
  { deep: true },
);
onMounted(() => void generate());
</script>

<template>
  <section
    class="generator"
    data-test="generator"
    :aria-label="t('generator.title')"
  >
    <div class="generator-output">
      <output class="mono" data-test="generator-value">{{ value }}</output>
      <button
        type="button"
        class="icon-button"
        :aria-label="t('generator.again')"
        data-test="generator-again"
        @click="generate"
      >
        <AppIcon ui="refresh" />
      </button>
    </div>
    <p class="small-text" data-test="generator-bits">
      {{ t("generator.bits", { bits }) }}
      <span v-if="short" class="text-warning" data-test="generator-short">{{
        t("generator.short")
      }}</span>
    </p>
    <fieldset class="plain choice-row">
      <legend class="sr-only">{{ t("generator.mode") }}</legend>
      <label class="choice"
        ><input
          v-model="options.mode"
          type="radio"
          value="chars"
          data-test="generator-chars"
        />
        {{ t("generator.chars") }}</label
      >
      <label class="choice"
        ><input
          v-model="options.mode"
          type="radio"
          value="words"
          data-test="generator-words"
        />
        {{ t("generator.words") }}</label
      >
    </fieldset>
    <template v-if="options.mode === 'chars'">
      <div class="field">
        <label for="generator-length">{{ t("generator.length") }}</label>
        <input
          id="generator-length"
          v-model.number="options.length"
          type="number"
          :min="GENERATOR_LIMITS.minLength"
          :max="GENERATOR_LIMITS.maxLength"
          data-test="generator-length"
        />
      </div>
      <fieldset class="plain choice-row">
        <legend class="sr-only">{{ t("generator.classes") }}</legend>
        <label class="choice"
          ><input v-model="options.upper" type="checkbox" /> A–Z</label
        >
        <label class="choice"
          ><input v-model="options.lower" type="checkbox" /> a–z</label
        >
        <label class="choice"
          ><input v-model="options.digits" type="checkbox" /> 0–9</label
        >
        <label class="choice"
          ><input
            v-model="options.symbols"
            type="checkbox"
            data-test="generator-symbols"
          />
          {{ t("generator.symbols") }}</label
        >
      </fieldset>
      <label class="choice"
        ><input v-model="options.excludeLookalikes" type="checkbox" />
        {{ t("generator.lookalikes") }}</label
      >
    </template>
    <template v-else>
      <div class="field">
        <label for="generator-count">{{ t("generator.wordCount") }}</label>
        <input
          id="generator-count"
          v-model.number="options.words"
          type="number"
          :min="GENERATOR_LIMITS.minWords"
          :max="GENERATOR_LIMITS.maxWords"
          data-test="generator-count"
        />
      </div>
      <div class="field">
        <label for="generator-separator">{{ t("generator.separator") }}</label>
        <input
          id="generator-separator"
          v-model="options.separator"
          maxlength="3"
          data-test="generator-separator"
        />
      </div>
      <label class="choice"
        ><input v-model="options.capitalize" type="checkbox" />
        {{ t("generator.capitalize") }}</label
      >
    </template>
    <p v-if="!valid" class="text-error small-text">
      {{ t("generator.invalid") }}
    </p>
    <ErrorNotice :error="error" />
    <div class="actions">
      <button
        type="button"
        :disabled="!valid || value === ''"
        data-test="generator-use"
        @click="emit('use', value)"
      >
        {{ t("generator.use") }}
      </button>
      <button
        type="button"
        class="secondary"
        :disabled="!valid"
        data-test="generator-save"
        @click="saveDefault"
      >
        {{ t("generator.saveDefault") }}
      </button>
      <button type="button" class="secondary" @click="emit('close')">
        {{ t("common.close") }}
      </button>
      <span v-if="saved" class="text-success small-text" role="status">{{
        t("generator.saved")
      }}</span>
    </div>
  </section>
</template>

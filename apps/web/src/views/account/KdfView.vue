<script setup lang="ts">
/** KDF upgrade. */
import { DEFAULT_KDF_PARAMS, KDF_LIMITS } from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../../components/ErrorNotice.vue";
import PasswordInput from "../../components/PasswordInput.vue";
import { toUiError, type UiError } from "../../errors";
import { useServices } from "../../services";
import { useSessionStore } from "../../stores/session";
import type { PasswordField } from "../../components/password-field";

const MIB = 1_048_576;
const PRESETS = {
  standard: { ops: DEFAULT_KDF_PARAMS.ops, mem: DEFAULT_KDF_PARAMS.mem / MIB },
  strong: { ops: 4, mem: 128 },
  veryStrong: { ops: 4, mem: 256 },
} as const;

const { t } = useI18n();
const session = useSessionStore();
const preset = ref<keyof typeof PRESETS | "custom">("strong");
const customOps = ref(session.kdf?.ops ?? 3);
const customMem = ref((session.kdf?.mem ?? DEFAULT_KDF_PARAMS.mem) / MIB);
const confirmLower = ref(false);
const password = ref<PasswordField>();
const busy = ref(false);
const done = ref(false);
const error = ref<UiError>();

const target = computed(() =>
  preset.value === "custom"
    ? { ops: customOps.value, mem: customMem.value }
    : PRESETS[preset.value],
);
const valid = computed(
  () =>
    Number.isInteger(target.value.ops) &&
    Number.isInteger(target.value.mem) &&
    target.value.ops >= KDF_LIMITS.minOps &&
    target.value.ops <= KDF_LIMITS.maxOps &&
    target.value.mem * MIB >= KDF_LIMITS.minMem &&
    target.value.mem * MIB <= KDF_LIMITS.maxMem,
);
const lower = computed(
  () =>
    session.kdf !== undefined &&
    (target.value.ops < session.kdf.ops ||
      target.value.mem * MIB < session.kdf.mem),
);

async function submit(): Promise<void> {
  if (!valid.value || (lower.value && !confirmLower.value)) return;
  const secret = password.value?.value() ?? "";
  password.value?.clear();
  busy.value = true;
  done.value = false;
  error.value = undefined;
  try {
    await useServices().account.upgradeKdf(secret, {
      alg: "argon2id13",
      ops: target.value.ops,
      mem: target.value.mem * MIB,
    });
    session.refreshFromAccount();
    session.banners.kdfBelowDefault =
      target.value.ops < DEFAULT_KDF_PARAMS.ops ||
      target.value.mem * MIB < DEFAULT_KDF_PARAMS.mem;
    session.kdfWarning = undefined;
    done.value = true;
    confirmLower.value = false;
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section data-test="kdf">
    <h2>{{ t("kdf.title") }}</h2>
    <p>{{ t("kdf.intro") }}</p>
    <p v-if="session.kdf" data-test="kdf-current">
      {{
        t("kdf.current", { ops: session.kdf.ops, mem: session.kdf.mem / MIB })
      }}
    </p>
    <form class="form" @submit.prevent="submit">
      <fieldset>
        <legend>{{ t("kdf.preset") }}</legend>
        <label class="choice"
          ><input v-model="preset" type="radio" value="standard" />
          {{ t("kdf.presetStandard") }}</label
        >
        <label class="choice"
          ><input v-model="preset" type="radio" value="strong" />
          {{ t("kdf.presetStrong") }}</label
        >
        <label class="choice"
          ><input v-model="preset" type="radio" value="veryStrong" />
          {{ t("kdf.presetVeryStrong") }}</label
        >
        <label class="choice"
          ><input
            v-model="preset"
            type="radio"
            value="custom"
            data-test="kdf-custom"
          />
          {{ t("kdf.presetCustom") }}</label
        >
      </fieldset>
      <template v-if="preset === 'custom'">
        <div class="field">
          <label for="kdf-ops">{{ t("kdf.ops") }}</label>
          <input
            id="kdf-ops"
            v-model.number="customOps"
            type="number"
            min="2"
            max="10"
            step="1"
          />
        </div>
        <div class="field">
          <label for="kdf-mem">{{ t("kdf.mem") }}</label>
          <input
            id="kdf-mem"
            v-model.number="customMem"
            type="number"
            min="19"
            max="1024"
            step="1"
          />
        </div>
      </template>
      <p v-if="!valid" class="text-error">{{ t("kdf.invalid") }}</p>
      <p v-if="valid && target.mem > 256" class="text-warning">
        {{ t("kdf.warnHigh") }}
      </p>
      <label v-if="valid && lower" class="choice">
        <input
          v-model="confirmLower"
          type="checkbox"
          data-test="kdf-confirm-lower"
        />
        {{ t("kdf.confirmLower") }}
      </label>
      <input
        type="email"
        name="email"
        autocomplete="username"
        :value="session.email"
        hidden
        readonly
      />
      <PasswordInput
        ref="password"
        name="password"
        :label="t('kdf.password')"
        autocomplete="current-password"
      />
      <ErrorNotice :error="error" />
      <p v-if="done" class="notice notice-success" role="status">
        {{ t("kdf.done") }}
      </p>
      <button
        type="submit"
        :disabled="busy || !valid || (lower && !confirmLower)"
        data-test="kdf-submit"
      >
        {{ busy ? t("kdf.busy") : t("kdf.submit") }}
      </button>
    </form>
  </section>
</template>

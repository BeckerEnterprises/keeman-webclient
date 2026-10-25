<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../../components/ErrorNotice.vue";
import PasswordInput from "../../components/PasswordInput.vue";
import StrengthMeter from "../../components/StrengthMeter.vue";
import { toUiError, type UiError } from "../../errors";
import {
  checkNewPassword,
  hasOuterSpace,
  type PasswordProblem,
} from "../../password";
import { useServices } from "../../services";
import { useSessionStore } from "../../stores/session";
import { usePasswordStrength } from "../../strength";
import type { PasswordField } from "../../components/password-field";

const { t } = useI18n();
const session = useSessionStore();
const email = ref(session.email ?? "");
const current = ref<PasswordField>();
const next = ref<PasswordField>();
const confirmation = ref<PasswordField>();
const strength = usePasswordStrength(email);
const problems = ref<PasswordProblem[]>([]);
const outerSpace = ref(false);
const busy = ref(false);
const done = ref(false);
const error = ref<UiError>();

function onInput(value: string): void {
  strength.rate(value);
  outerSpace.value = hasOuterSpace(value);
}

function clearAll(): void {
  current.value?.clear();
  next.value?.clear();
  confirmation.value?.clear();
  strength.rate("");
}

async function submit(): Promise<void> {
  const scorer = strength.scorer();
  if (!scorer) return;
  const previous = current.value?.value() ?? "";
  const password = next.value?.value() ?? "";
  problems.value = checkNewPassword(
    {
      password,
      confirmation: confirmation.value?.value() ?? "",
      email: email.value,
      previous,
    },
    scorer,
  );
  if (problems.value.length > 0) return;
  clearAll();
  busy.value = true;
  done.value = false;
  error.value = undefined;
  try {
    await useServices().account.changePassword(previous, password);
    session.refreshFromAccount();
    session.banners.kdfBelowDefault = false;
    done.value = true;
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section data-test="password-change">
    <h2>{{ t("password.title") }}</h2>
    <p>{{ t("password.intro") }}</p>
    <form class="form" @submit.prevent="submit">
      <input
        type="email"
        name="email"
        autocomplete="username"
        :value="email"
        hidden
        readonly
      />
      <PasswordInput
        ref="current"
        name="current-password"
        :label="t('password.current')"
        autocomplete="current-password"
      />
      <PasswordInput
        ref="next"
        name="new-password"
        :label="t('password.new')"
        autocomplete="new-password"
        @input="onInput"
      />
      <StrengthMeter
        :score="strength.score.value"
        :state="strength.state.value"
      />
      <p v-if="outerSpace" class="text-warning">{{ t("rules.outerSpace") }}</p>
      <PasswordInput
        ref="confirmation"
        name="confirm-password"
        :label="t('password.confirm')"
        autocomplete="new-password"
      />
      <ul
        v-if="problems.length > 0"
        class="problems"
        role="alert"
        data-test="password-problems"
      >
        <li v-for="problem in problems" :key="problem">
          {{ t(`rules.${problem}`) }}
        </li>
      </ul>
      <ErrorNotice :error="error" />
      <p v-if="done" class="notice notice-success" role="status">
        {{ t("password.done") }}
      </p>
      <button
        type="submit"
        :disabled="busy || strength.state.value !== 'ready'"
        data-test="password-submit"
      >
        {{ busy ? t("password.busy") : t("password.submit") }}
      </button>
    </form>
  </section>
</template>

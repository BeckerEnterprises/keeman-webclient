<script setup lang="ts">
/**
 * Registration: the request is built once and resent unchanged
 * after network errors; the recovery key is shown only after success and
 * must be confirmed with its last group.
 */
import { ApiError, NetworkError, type PendingRegistration } from "@keeman/core";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave, useRouter } from "vue-router";
import ErrorNotice from "../components/ErrorNotice.vue";
import PasswordInput from "../components/PasswordInput.vue";
import RecoveryKeyPanel from "../components/RecoveryKeyPanel.vue";
import StrengthMeter from "../components/StrengthMeter.vue";
import { toUiError, type UiError } from "../errors";
import { currentLocale } from "../i18n";
import {
  checkNewPassword,
  hasOuterSpace,
  type PasswordProblem,
} from "../password";
import { useServices } from "../services";
import { useSessionStore } from "../stores/session";
import { useVaultsStore } from "../stores/vaults";
import { usePasswordStrength } from "../strength";
import type { PasswordField } from "../components/password-field";

const { t } = useI18n();
const session = useSessionStore();
const router = useRouter();
const inviteCode = ref("");
const email = ref("");
const password = ref<PasswordField>();
const confirmation = ref<PasswordField>();
const strength = usePasswordStrength(email);
const problems = ref<PasswordProblem[]>([]);
const outerSpace = ref(false);
const step = ref<"form" | "retry" | "recovery">("form");
const busy = ref(false);
const error = ref<UiError>();
/** Shown only after a successful registration; cleared on unmount. */
const recoveryKey = ref("");
let pending: PendingRegistration | undefined;

function onPasswordInput(value: string): void {
  strength.rate(value);
  outerSpace.value = hasOuterSpace(value);
}

function readPasswords():
  { password: string; confirmation: string } | undefined {
  const scorer = strength.scorer();
  const values = {
    password: password.value?.value() ?? "",
    confirmation: confirmation.value?.value() ?? "",
  };
  if (!scorer) return undefined;
  problems.value = checkNewPassword({ ...values, email: email.value }, scorer);
  return problems.value.length === 0 ? values : undefined;
}

async function submit(): Promise<void> {
  error.value = undefined;
  busy.value = true;
  try {
    if (!pending) {
      const values = readPasswords();
      if (!values) return;
      password.value?.clear();
      confirmation.value?.clear();
      strength.rate("");
      pending = await useServices().account.startRegistration({
        email: email.value,
        password: values.password,
        inviteCode:
          inviteCode.value.trim() === "" ? undefined : inviteCode.value.trim(),
        language: currentLocale(),
      });
    }
    await pending.submit();
    recoveryKey.value = pending.recoveryKey;
    pending = undefined;
    session.confirmingRecoveryKey = true;
    session.applyUnlocked();
    const { account, tabs } = useServices();
    tabs.send({ type: "session", userId: account.userId ?? "" });
    step.value = "recovery";
    // The first database, in the background while the key is shown.
    void useVaultsStore().createFirstVault({
      name: t("vaults.defaultName"),
      rootName: t("vaults.defaultName"),
      recycleBinName: t("vaults.recycleBin"),
    });
  } catch (caught) {
    error.value = toUiError(caught);
    const retryable =
      pending &&
      !pending.isDiscarded &&
      (caught instanceof NetworkError ||
        (caught instanceof ApiError &&
          (caught.status >= 500 ||
            caught.status === 408 ||
            caught.status === 429)));
    if (retryable) {
      step.value = "retry";
    } else {
      pending?.discard();
      pending = undefined;
      step.value = "form";
    }
  } finally {
    busy.value = false;
  }
}

function abandon(): void {
  pending?.discard();
  pending = undefined;
  error.value = undefined;
  step.value = "form";
}

async function confirmRecoveryKey(): Promise<void> {
  error.value = undefined;
  busy.value = true;
  try {
    await useServices().account.confirmRecoveryKey();
    session.confirmingRecoveryKey = false;
    session.refreshFromAccount();
    recoveryKey.value = "";
    await router.replace("/home");
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

function warnOnUnload(event: BeforeUnloadEvent): void {
  if (step.value === "recovery") event.preventDefault();
}

onBeforeRouteLeave(() => {
  if (step.value !== "recovery" || !session.confirmingRecoveryKey) return true;
  return window.confirm(t("recovery.leave"));
});

onMounted(() => {
  window.addEventListener("beforeunload", warnOnUnload);
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnOnUnload);
  pending?.discard();
  pending = undefined;
  recoveryKey.value = "";
  session.confirmingRecoveryKey = false;
});
</script>

<template>
  <section class="narrow" data-test="register">
    <template v-if="step === 'recovery'">
      <RecoveryKeyPanel
        :recovery-key="recoveryKey"
        :busy="busy"
        :action="t('recovery.confirm')"
        @confirm="confirmRecoveryKey"
      />
      <ErrorNotice :error="error" />
    </template>
    <template v-else>
      <h1>{{ t("register.title") }}</h1>
      <p>{{ t("register.intro") }}</p>
      <form class="form" @submit.prevent="submit">
        <fieldset :disabled="step === 'retry' || busy" class="plain">
          <div class="field">
            <label for="register-invite">{{ t("register.inviteCode") }}</label>
            <input
              id="register-invite"
              v-model="inviteCode"
              name="invite"
              autocomplete="off"
              spellcheck="false"
              class="mono"
            />
          </div>
          <div class="field">
            <label for="register-email">{{ t("register.email") }}</label>
            <input
              id="register-email"
              v-model="email"
              name="email"
              type="email"
              autocomplete="username"
              required
            />
          </div>
          <PasswordInput
            ref="password"
            name="new-password"
            :label="t('register.password')"
            autocomplete="new-password"
            @input="onPasswordInput"
          />
          <StrengthMeter
            :score="strength.score.value"
            :state="strength.state.value"
          />
          <p v-if="outerSpace" class="text-warning">
            {{ t("rules.outerSpace") }}
          </p>
          <PasswordInput
            ref="confirmation"
            name="confirm-password"
            :label="t('register.confirm')"
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
        </fieldset>
        <p v-if="step === 'retry'" class="notice notice-warning">
          {{ t("register.retryInfo") }}
        </p>
        <ErrorNotice :error="error" />
        <div class="actions">
          <button
            type="submit"
            :disabled="busy || strength.state.value !== 'ready'"
            data-test="register-submit"
          >
            {{
              busy
                ? t("register.busy")
                : step === "retry"
                  ? t("common.retry")
                  : t("register.submit")
            }}
          </button>
          <button
            v-if="step === 'retry'"
            type="button"
            class="secondary"
            @click="abandon"
          >
            {{ t("register.abandon") }}
          </button>
        </div>
      </form>
      <p>
        <RouterLink to="/login">{{ t("register.toLogin") }}</RouterLink>
      </p>
    </template>
  </section>
</template>

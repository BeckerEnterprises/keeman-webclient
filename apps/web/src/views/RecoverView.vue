<script setup lang="ts">
/**
 * Recovery with the recovery key: key, second factor if
 * needed, new master password, new recovery key, finish. The process holds
 * the keys in the core and stays out of the reactive state; leaving the
 * view discards it.
 */
import {
  AccountError,
  ApiError,
  NetworkError,
  type RecoveryProcess,
  type RecoveryStep,
  type SecondFactorMethod,
} from "@keeman/core";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave } from "vue-router";
import ErrorNotice from "../components/ErrorNotice.vue";
import PasswordInput from "../components/PasswordInput.vue";
import RecoveryKeyPanel from "../components/RecoveryKeyPanel.vue";
import SecondFactorForm from "../components/SecondFactorForm.vue";
import StrengthMeter from "../components/StrengthMeter.vue";
import { toUiError, type UiError } from "../errors";
import {
  checkNewPassword,
  hasOuterSpace,
  type PasswordProblem,
} from "../password";
import { useServices } from "../services";
import { useSessionStore } from "../stores/session";
import { usePasswordStrength } from "../strength";
import { getPasskey } from "../webauthn";
import type { PasswordField } from "../components/password-field";

type Stage = "start" | "second_factor" | "password" | "confirm" | "retry";

const { t } = useI18n();
const session = useSessionStore();
const email = ref("");
const recoveryKeyInput = ref("");
const password = ref<PasswordField>();
const confirmation = ref<PasswordField>();
const strength = usePasswordStrength(email);
const problems = ref<PasswordProblem[]>([]);
const outerSpace = ref(false);
const stage = ref<Stage>("start");
const methods = ref<SecondFactorMethod[]>([]);
const busy = ref(false);
const error = ref<UiError>();
/** The new recovery key, shown before the finish; cleared on unmount. */
const newRecoveryKey = ref("");
let process: RecoveryProcess | undefined;
let finishing = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function show(caught: unknown): void {
  const ui = toUiError(caught);
  // Here `invalid_credentials` means the recovery key, not the password.
  error.value =
    ui.key === "invalid_credentials" ? { ...ui, key: "recovery_invalid" } : ui;
}

/** Ends the attempt and starts over (time out, server ended it, cancel). */
function reset(): void {
  clearTimeout(timer);
  process?.discard();
  process = undefined;
  finishing = false;
  newRecoveryKey.value = "";
  methods.value = [];
  stage.value = "start";
}

/** The recovery token runs out unless a finish is under way. */
function watchExpiry(): void {
  clearTimeout(timer);
  const current = process;
  if (!current || finishing) return;
  timer = setTimeout(
    () => {
      if (finishing || process !== current) return;
      reset();
      error.value = { key: "challenge_expired" };
    },
    Math.max(0, current.expiresAt - Date.now()),
  );
}

function follow(step: RecoveryStep): void {
  const current = process;
  if (step.stage === "done") {
    clearTimeout(timer);
    process = undefined;
    newRecoveryKey.value = "";
    session.finishRecovery(step.report);
    return;
  }
  if (step.stage === "second_factor" && current)
    methods.value = [...current.methods];
  stage.value = step.stage;
  watchExpiry();
}

async function start(): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    process = await useServices().account.startRecovery(
      email.value,
      recoveryKeyInput.value,
    );
    recoveryKeyInput.value = "";
    follow({
      stage: process.stage === "second_factor" ? "second_factor" : "password",
    });
  } catch (caught) {
    process = undefined;
    show(caught);
  } finally {
    busy.value = false;
  }
}

/** Second factor; a discarded process means: start over. */
async function factor(
  run: (p: RecoveryProcess) => Promise<RecoveryStep>,
): Promise<void> {
  const current = process;
  if (!current) throw new AccountError("challenge_expired");
  try {
    follow(await run(current));
  } catch (caught) {
    if (current.isDiscarded) reset();
    throw caught;
  }
}

const totp = (code: string) => factor((p) => p.totp(code));
const backupCode = (code: string) => factor((p) => p.backupCode(code));
const passkey = () =>
  factor(async (p) => p.passkey(await getPasskey(await p.passkeyOptions())));

function onPasswordInput(value: string): void {
  strength.rate(value);
  outerSpace.value = hasOuterSpace(value);
}

async function prepare(): Promise<void> {
  const scorer = strength.scorer();
  const current = process;
  if (!scorer || !current) return;
  const values = {
    password: password.value?.value() ?? "",
    confirmation: confirmation.value?.value() ?? "",
  };
  problems.value = checkNewPassword({ ...values, email: email.value }, scorer);
  if (problems.value.length > 0) return;
  password.value?.clear();
  confirmation.value?.clear();
  strength.rate("");
  busy.value = true;
  error.value = undefined;
  try {
    newRecoveryKey.value = await current.prepare(values.password);
    stage.value = "confirm";
  } catch (caught) {
    if (current.isDiscarded) reset();
    show(caught);
  } finally {
    busy.value = false;
  }
}

async function finish(): Promise<void> {
  const current = process;
  if (!current) return;
  finishing = true;
  clearTimeout(timer);
  busy.value = true;
  error.value = undefined;
  try {
    follow(await current.finish());
  } catch (caught) {
    show(caught);
    const transient =
      caught instanceof NetworkError ||
      (caught instanceof ApiError &&
        (caught.status >= 500 ||
          caught.status === 408 ||
          caught.status === 429));
    if (current.isDiscarded || !transient) reset();
    else stage.value = "retry";
  } finally {
    busy.value = false;
  }
}

function cancel(): void {
  reset();
  error.value = undefined;
}

function warnOnUnload(event: BeforeUnloadEvent): void {
  if (stage.value === "confirm" || stage.value === "retry")
    event.preventDefault();
}

onBeforeRouteLeave(() => {
  if (
    (stage.value !== "confirm" && stage.value !== "retry") ||
    session.phase !== "loggedOut"
  )
    return true;
  return window.confirm(t("recover.leave"));
});
onMounted(() => {
  window.addEventListener("beforeunload", warnOnUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnOnUnload);
  clearTimeout(timer);
  process?.discard();
  process = undefined;
  newRecoveryKey.value = "";
});
</script>

<template>
  <section class="narrow" data-test="recover">
    <h1>{{ t("recover.title") }}</h1>
    <template v-if="stage === 'start'">
      <p>{{ t("recover.intro") }}</p>
      <form class="form" @submit.prevent="start">
        <div class="field">
          <label for="recover-email">{{ t("recover.email") }}</label>
          <input
            id="recover-email"
            v-model="email"
            name="email"
            type="email"
            autocomplete="username"
            required
          />
        </div>
        <div class="field">
          <label for="recover-key">{{ t("recover.key") }}</label>
          <textarea
            id="recover-key"
            v-model="recoveryKeyInput"
            class="mono"
            rows="3"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            required
            data-test="recover-key"
          ></textarea>
        </div>
        <ErrorNotice :error="error" />
        <button type="submit" :disabled="busy" data-test="recover-start">
          {{ busy ? t("recover.busy") : t("recover.start") }}
        </button>
      </form>
    </template>
    <template v-else-if="stage === 'second_factor'">
      <SecondFactorForm
        :methods="methods"
        :totp="totp"
        :backup-code="backupCode"
        :passkey="passkey"
        @cancel="cancel"
      />
    </template>
    <template v-else-if="stage === 'password'">
      <p>{{ t("recover.passwordIntro") }}</p>
      <p class="notice notice-info">{{ t("recover.effects") }}</p>
      <form class="form" @submit.prevent="prepare">
        <input
          type="email"
          name="email"
          autocomplete="username"
          :value="email"
          hidden
          readonly
        />
        <PasswordInput
          ref="password"
          name="new-password"
          :label="t('recover.password')"
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
          :label="t('recover.confirm')"
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
        <div class="actions">
          <button
            type="submit"
            :disabled="busy || strength.state.value !== 'ready'"
            data-test="recover-password"
          >
            {{ busy ? t("recover.preparing") : t("recover.next") }}
          </button>
          <button type="button" class="secondary" @click="cancel">
            {{ t("common.cancel") }}
          </button>
        </div>
      </form>
    </template>
    <template v-else>
      <p v-if="stage === 'confirm'">{{ t("recover.newKeyIntro") }}</p>
      <RecoveryKeyPanel
        v-if="stage === 'confirm'"
        :recovery-key="newRecoveryKey"
        :busy="busy"
        :action="t('recover.finish')"
        @confirm="finish"
      />
      <template v-else>
        <p class="notice notice-warning">{{ t("recover.retryInfo") }}</p>
        <div class="actions">
          <button
            type="button"
            :disabled="busy"
            data-test="recover-retry"
            @click="finish"
          >
            {{ busy ? t("recover.finishing") : t("common.retry") }}
          </button>
          <button type="button" class="secondary" @click="cancel">
            {{ t("common.cancel") }}
          </button>
        </div>
      </template>
      <ErrorNotice :error="error" />
    </template>
    <p v-if="stage === 'start'">
      <RouterLink to="/login">{{ t("recover.toLogin") }}</RouterLink>
    </p>
  </section>
</template>

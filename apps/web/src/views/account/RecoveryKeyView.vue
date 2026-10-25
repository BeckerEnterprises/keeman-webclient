<script setup lang="ts">
/** Recovery key renewal: the old key stays valid until commit. */
import { AccountError, type RecoveryKeyRenewal } from "@keeman/core";
import { onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { onBeforeRouteLeave } from "vue-router";
import ErrorNotice from "../../components/ErrorNotice.vue";
import PasswordInput from "../../components/PasswordInput.vue";
import RecoveryKeyPanel from "../../components/RecoveryKeyPanel.vue";
import { toUiError, type UiError } from "../../errors";
import { useServices } from "../../services";
import { useSessionStore } from "../../stores/session";
import type { PasswordField } from "../../components/password-field";

const { t } = useI18n();
const session = useSessionStore();
const password = ref<PasswordField>();
const step = ref<"password" | "show" | "reauth" | "done">("password");
const busy = ref(false);
const error = ref<UiError>();
const recoveryKey = ref("");
let renewal: RecoveryKeyRenewal | undefined;

async function start(): Promise<void> {
  const secret = password.value?.value() ?? "";
  password.value?.clear();
  busy.value = true;
  error.value = undefined;
  try {
    if (step.value === "reauth" && renewal) {
      await renewal.reauthenticate(secret);
      await commit();
      return;
    }
    renewal = await useServices().account.startRecoveryKeyRenewal(secret);
    recoveryKey.value = renewal.recoveryKey;
    step.value = "show";
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

async function commit(): Promise<void> {
  if (!renewal) return;
  busy.value = true;
  error.value = undefined;
  try {
    await renewal.commit();
    renewal = undefined;
    recoveryKey.value = "";
    session.refreshFromAccount();
    step.value = "done";
  } catch (caught) {
    if (caught instanceof AccountError && caught.code === "reauth_required") {
      step.value = "reauth";
      error.value = { key: "reauth_required" };
    } else {
      error.value = toUiError(caught);
    }
  } finally {
    busy.value = false;
  }
}

function warnOnUnload(event: BeforeUnloadEvent): void {
  if (step.value === "show" || step.value === "reauth") event.preventDefault();
}

onBeforeRouteLeave(() => {
  if (
    (step.value !== "show" && step.value !== "reauth") ||
    session.phase !== "unlocked"
  )
    return true;
  return window.confirm(t("recovery.leave"));
});
onMounted(() => {
  window.addEventListener("beforeunload", warnOnUnload);
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnOnUnload);
  renewal = undefined;
  recoveryKey.value = "";
});
</script>

<template>
  <section data-test="recovery-renew">
    <h2>{{ t("renew.title") }}</h2>
    <RecoveryKeyPanel
      v-if="step === 'show'"
      :recovery-key="recoveryKey"
      :busy="busy"
      :action="t('renew.commit')"
      @confirm="commit"
    />
    <template v-else-if="step === 'done'">
      <p class="notice notice-success" role="status">{{ t("renew.done") }}</p>
    </template>
    <template v-else>
      <p>{{ step === "reauth" ? t("renew.reauth") : t("renew.intro") }}</p>
      <form class="form" @submit.prevent="start">
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
          :label="t('renew.password')"
          autocomplete="current-password"
        />
        <button type="submit" :disabled="busy" data-test="renew-start">
          {{
            busy
              ? t("renew.busy")
              : step === "reauth"
                ? t("renew.commit")
                : t("renew.start")
          }}
        </button>
      </form>
    </template>
    <ErrorNotice :error="error" />
  </section>
</template>

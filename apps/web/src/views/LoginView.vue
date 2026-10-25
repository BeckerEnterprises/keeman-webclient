<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../components/ErrorNotice.vue";
import PasswordInput from "../components/PasswordInput.vue";
import SecondFactorForm from "../components/SecondFactorForm.vue";
import { toUiError, type UiError } from "../errors";
import { useSessionStore } from "../stores/session";
import type { PasswordField } from "../components/password-field";

const { t } = useI18n();
const session = useSessionStore();
const email = ref("");
const password = ref<PasswordField>();
const busy = ref(false);
const error = ref<UiError>();

async function submit(): Promise<void> {
  const secret = password.value?.value() ?? "";
  password.value?.clear();
  busy.value = true;
  error.value = undefined;
  try {
    await session.login(email.value, secret);
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="narrow" data-test="login">
    <h1>{{ t("login.title") }}</h1>
    <p v-if="session.notice === 'expired'" class="notice notice-info">
      {{ t("login.expired") }}
    </p>
    <p
      v-if="session.notice === 'accountDeleted'"
      class="notice notice-success"
      data-test="account-deleted"
    >
      {{ t("deleteAccount.done") }}
    </p>
    <p
      v-if="session.notice === 'secondFactorExpired'"
      class="notice notice-info"
      data-test="second-factor-expired"
    >
      {{ t("secondFactor.expired") }}
    </p>
    <SecondFactorForm
      v-if="session.secondFactor"
      :methods="session.secondFactor.methods"
      :totp="session.secondFactorTotp"
      :backup-code="session.secondFactorBackupCode"
      :passkey="session.secondFactorPasskey"
      @cancel="session.endSecondFactor()"
    />
    <form v-else class="form" @submit.prevent="submit">
      <div class="field">
        <label for="login-email">{{ t("login.email") }}</label>
        <input
          id="login-email"
          v-model="email"
          name="email"
          type="email"
          autocomplete="username"
          required
        />
      </div>
      <PasswordInput
        ref="password"
        name="password"
        :label="t('login.password')"
        autocomplete="current-password"
      />
      <ErrorNotice :error="error" />
      <button type="submit" :disabled="busy" data-test="login-submit">
        {{ busy ? t("login.busy") : t("login.submit") }}
      </button>
    </form>
    <p v-if="!session.secondFactor">
      <RouterLink to="/recover" data-test="to-recover">{{
        t("login.forgot")
      }}</RouterLink>
    </p>
    <p v-if="!session.secondFactor">
      <RouterLink to="/register">{{ t("login.toRegister") }}</RouterLink>
    </p>
  </section>
</template>

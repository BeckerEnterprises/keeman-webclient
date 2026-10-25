<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import ErrorNotice from "../components/ErrorNotice.vue";
import PasswordInput from "../components/PasswordInput.vue";
import { toUiError, type UiError } from "../errors";
import { useSessionStore } from "../stores/session";
import type { PasswordField } from "../components/password-field";

const { t } = useI18n();
const session = useSessionStore();
const router = useRouter();
const password = ref<PasswordField>();
const busy = ref(false);
const error = ref<UiError>();

onMounted(() => {
  password.value?.focus();
});

async function submit(): Promise<void> {
  const secret = password.value?.value() ?? "";
  password.value?.clear();
  busy.value = true;
  error.value = undefined;
  try {
    await session.unlock(secret);
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

async function logout(): Promise<void> {
  await session.logout().catch(() => undefined);
}

/** The recovery starts logged out. */
async function recover(): Promise<void> {
  await session.logout().catch(() => undefined);
  await router.replace("/recover");
}
</script>

<template>
  <section class="narrow" data-test="unlock">
    <h1>{{ t("unlock.title") }}</h1>
    <p>{{ t("unlock.intro", { email: session.email ?? "" }) }}</p>
    <form class="form" @submit.prevent="submit">
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
        :label="t('unlock.password')"
        autocomplete="current-password"
      />
      <ErrorNotice :error="error" />
      <button type="submit" :disabled="busy" data-test="unlock-submit">
        {{ busy ? t("unlock.busy") : t("unlock.submit") }}
      </button>
    </form>
    <p>
      <button
        type="button"
        class="link"
        data-test="unlock-logout"
        @click="logout"
      >
        {{ t("unlock.logout") }}
      </button>
    </p>
    <p>
      <button
        type="button"
        class="link"
        data-test="unlock-recover"
        @click="recover"
      >
        {{ t("unlock.forgot") }}
      </button>
    </p>
  </section>
</template>

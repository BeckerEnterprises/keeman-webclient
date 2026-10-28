<script setup lang="ts">
/**
 * Deleting the account: shows which databases go and which
 * are left, then e-mail address and master password.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import ErrorNotice from "../../components/ErrorNotice.vue";
import PasswordInput from "../../components/PasswordInput.vue";
import type { PasswordField } from "../../components/password-field";
import { toUiError, type UiError } from "../../errors";
import { useSessionStore } from "../../stores/session";
import { useVaultsStore } from "../../stores/vaults";

const { t } = useI18n();
const session = useSessionStore();
const vaults = useVaultsStore();
const email = ref("");
const password = ref<PasswordField>();
const busy = ref(false);
const error = ref<UiError>();

const deleted = computed(() => vaults.vaults.filter((v) => v.memberCount <= 1));
const left = computed(() => vaults.vaults.filter((v) => v.memberCount > 1));
/**
 * Owner of a list with an open warning, or one that does not load: nothing
 * is signed there, no step-down.
 */
const warned = computed(() =>
  vaults.vaults.filter(
    (v) =>
      v.role === "owner" &&
      v.memberCount > 1 &&
      (v.roles.status === "rollback" ||
        v.roles.status === "fork" ||
        v.roles.status === "invalid" ||
        v.roles.status === "unavailable"),
  ),
);
const matches = computed(
  () =>
    email.value.trim().toLowerCase() ===
    (session.email ?? "").trim().toLowerCase(),
);

async function submit(): Promise<void> {
  const value = password.value?.value() ?? "";
  password.value?.clear();
  busy.value = true;
  error.value = undefined;
  try {
    await session.deleteAccount(value);
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section data-test="delete-account">
    <h2>{{ t("deleteAccount.title") }}</h2>
    <p class="notice notice-warning">{{ t("deleteAccount.intro") }}</p>
    <h3>{{ t("deleteAccount.deleted") }}</h3>
    <ul v-if="deleted.length > 0" data-test="delete-account-vaults">
      <li v-for="vault in deleted" :key="vault.id">
        {{ vault.name ?? t("vaults.unnamed") }}
      </li>
    </ul>
    <p v-else class="muted">{{ t("deleteAccount.none") }}</p>
    <template v-if="left.length > 0">
      <h3>{{ t("deleteAccount.left") }}</h3>
      <ul>
        <li v-for="vault in left" :key="vault.id">
          {{ vault.name ?? t("vaults.unnamed") }}
        </li>
      </ul>
    </template>
    <div
      v-if="warned.length > 0"
      class="notice notice-error"
      role="alert"
      data-test="delete-account-roles-warning"
    >
      <p>{{ t("deleteAccount.rolesWarning") }}</p>
      <ul>
        <li v-for="vault in warned" :key="vault.id">
          <RouterLink :to="`/databases/${vault.id}`">{{
            vault.name ?? t("vaults.unnamed")
          }}</RouterLink>
        </li>
      </ul>
    </div>
    <form class="form" @submit.prevent="submit">
      <div class="field">
        <label for="delete-account-email">{{ t("deleteAccount.email") }}</label>
        <input
          id="delete-account-email"
          v-model="email"
          type="email"
          autocomplete="off"
          data-test="delete-account-email"
        />
      </div>
      <PasswordInput
        ref="password"
        name="current-password"
        :label="t('deleteAccount.password')"
        autocomplete="current-password"
      />
      <ErrorNotice :error="error" />
      <button
        type="submit"
        class="danger"
        :disabled="busy || !matches || warned.length > 0"
        data-test="delete-account-submit"
      >
        {{ busy ? t("common.working") : t("deleteAccount.submit") }}
      </button>
    </form>
  </section>
</template>

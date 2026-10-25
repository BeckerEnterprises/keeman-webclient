<script setup lang="ts">
/**
 * Deleting a database: its name typed in, then the master
 * password, checked locally before the reauth.
 */
import type { VaultView } from "@keeman/core";
import { computed, onMounted, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../errors";
import { useVaultsStore } from "../stores/vaults";
import ErrorNotice from "./ErrorNotice.vue";
import PasswordInput from "./PasswordInput.vue";
import type { PasswordField } from "./password-field";

const props = defineProps<{ vault: VaultView }>();
const emit = defineEmits<{ close: [deleted: boolean] }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const id = useId();
const dialog = ref<HTMLDialogElement>();
const typed = ref("");
const password = ref<PasswordField>();
const busy = ref(false);
const error = ref<UiError>();
const expected = computed(() => props.vault.name ?? "");
const matches = computed(() => typed.value.trim() === expected.value.trim());

onMounted(() => {
  dialog.value?.showModal();
});

async function remove(): Promise<void> {
  const value = password.value?.value() ?? "";
  password.value?.clear();
  busy.value = true;
  error.value = undefined;
  try {
    await vaults.engine().deleteVault(props.vault.id, value);
    dialog.value?.close();
    emit("close", true);
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}

function cancel(): void {
  password.value?.clear();
  dialog.value?.close();
  emit("close", false);
}
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog"
    data-test="vault-delete"
    @cancel.prevent="cancel"
  >
    <h2>{{ t("vaults.deleteTitle") }}</h2>
    <p>{{ t("vaults.deleteText", { name: expected }) }}</p>
    <form class="form" @submit.prevent="remove">
      <div class="field">
        <label :for="`${id}-name`">{{ t("vaults.deleteConfirmName") }}</label>
        <input
          :id="`${id}-name`"
          v-model="typed"
          autocomplete="off"
          data-test="vault-delete-name"
        />
      </div>
      <PasswordInput
        ref="password"
        name="current-password"
        :label="t('vaults.deletePassword')"
        autocomplete="current-password"
      />
      <ErrorNotice :error="error" />
      <div class="actions">
        <button
          type="submit"
          class="danger"
          :disabled="busy || !matches"
          data-test="vault-delete-submit"
        >
          {{ busy ? t("common.working") : t("vaults.deleteSubmit") }}
        </button>
        <button type="button" class="secondary" @click="cancel">
          {{ t("common.cancel") }}
        </button>
      </div>
    </form>
  </dialog>
</template>

<script setup lang="ts">
/**
 * Name, description and colour of a database; with `full` also
 * icon, recycle bin and history length.
 */
import type { IconRef, VaultView } from "@keeman/core";
import { ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../errors";
import { describeNotices, useVaultsStore } from "../stores/vaults";
import ErrorNotice from "./ErrorNotice.vue";
import IconPicker from "./ui/IconPicker.vue";

const props = defineProps<{ vault: VaultView; full?: boolean }>();
const emit = defineEmits<{
  done: [notices: ReturnType<typeof describeNotices>];
}>();
const { t } = useI18n();
const vaults = useVaultsStore();
const id = useId();
const name = ref(props.vault.name ?? "");
const description = ref(props.vault.description);
const useColor = ref(props.vault.color !== null);
const color = ref(props.vault.color ?? "#2563eb");
const icon = ref<IconRef | null>(props.vault.iconRef);
const recycleBin = ref(props.vault.recycleBinEnabled);
const history = ref(props.vault.historyMaxItems);
const busy = ref(false);
const error = ref<UiError>();

async function save(): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    const result = await vaults.engine().updateVault(props.vault.id, {
      name: name.value,
      description: description.value,
      color: useColor.value ? color.value : null,
      ...(props.full
        ? {
            icon: icon.value,
            recycleBinEnabled: recycleBin.value,
            historyMaxItems: history.value,
          }
        : {}),
    });
    emit("done", describeNotices(result.notices));
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <form class="form inline-form" data-test="vault-edit" @submit.prevent="save">
    <div class="field">
      <label :for="`${id}-name`">{{ t("vaults.name") }}</label>
      <input
        :id="`${id}-name`"
        v-model="name"
        maxlength="256"
        required
        data-test="vault-edit-name"
      />
    </div>
    <div class="field">
      <label :for="`${id}-description`">{{ t("vaults.description") }}</label>
      <input :id="`${id}-description`" v-model="description" maxlength="1000" />
    </div>
    <label class="choice">
      <input v-model="useColor" type="checkbox" />
      {{ t("vaults.useColor") }}
    </label>
    <div v-if="useColor" class="field">
      <label :for="`${id}-color`">{{ t("vaults.color") }}</label>
      <input :id="`${id}-color`" v-model="color" type="color" />
    </div>
    <template v-if="full">
      <IconPicker
        v-model="icon"
        :label="t('vaults.icon')"
        :none-label="t('vaults.iconDefault')"
        fallback="database"
        :vault-id="vault.id"
      />
      <label class="choice">
        <input
          v-model="recycleBin"
          type="checkbox"
          data-test="vault-edit-bin"
        />
        {{ t("vaults.recycleBinEnabled") }}
      </label>
      <div class="field">
        <label :for="`${id}-history`">{{ t("vaults.historyMaxItems") }}</label>
        <input
          :id="`${id}-history`"
          v-model.number="history"
          type="number"
          min="0"
          max="100"
          required
          data-test="vault-edit-history"
        />
      </div>
    </template>
    <ErrorNotice :error="error" />
    <div class="actions">
      <button type="submit" :disabled="busy" data-test="vault-edit-save">
        {{ t("common.save") }}
      </button>
      <button type="button" class="secondary" @click="emit('done', [])">
        {{ t("common.cancel") }}
      </button>
    </div>
  </form>
</template>

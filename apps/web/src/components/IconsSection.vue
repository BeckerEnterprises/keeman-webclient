<script setup lang="ts">
/**
 * The custom icons of a database: how many there are, how many
 * no object uses, and "Remove unused icons" with a confirmation.
 * Blocked while corrupt objects may refer to icons, and when read-only.
 */
import type { VaultView } from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toUiError, type UiError } from "../errors";
import { useVaultsStore } from "../stores/vaults";
import ConfirmDialog from "./dialogs/ConfirmDialog.vue";
import ErrorNotice from "./ErrorNotice.vue";
import AppIcon from "./ui/AppIcon";

const props = defineProps<{ vault: VaultView }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const confirming = ref(false);
const busy = ref(false);
const removed = ref<number>();
const error = ref<UiError>();

const icons = computed(() => [...props.vault.icons.values()]);
const unused = computed(
  () => icons.value.filter((icon) => !icon.used && icon.writable).length,
);

async function remove(): Promise<void> {
  busy.value = true;
  error.value = undefined;
  try {
    removed.value = await vaults.engine().removeUnusedIcons(props.vault.id);
    confirming.value = false;
  } catch (caught) {
    error.value = toUiError(caught);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="icons-section" data-test="icons-section">
    <h2>{{ t("vault.icons.title") }}</h2>
    <p data-test="icons-count">
      {{ t("vault.icons.count", { count: icons.length }) }}
      <template v-if="icons.length > 0">
        {{ t("vault.icons.unused", { count: unused }) }}
      </template>
    </p>
    <div v-if="icons.length > 0" class="icon-strip" aria-hidden="true">
      <AppIcon
        v-for="icon in icons"
        :key="icon.id"
        :src="icon.src"
        name="image"
        :size="20"
        :title="icon.name"
      />
    </div>
    <p v-if="vault.iconCleanup === 'corrupt'" class="hint">
      {{ t("vault.icons.blockedCorrupt") }}
    </p>
    <button
      type="button"
      class="secondary"
      :disabled="vault.iconCleanup !== 'ok' || unused === 0 || busy"
      data-test="icons-remove-unused"
      @click="confirming = true"
    >
      {{ t("vault.icons.remove") }}
    </button>
    <p v-if="removed !== undefined" role="status" data-test="icons-removed">
      {{ t("vault.icons.removed", { count: removed }) }}
    </p>
    <ErrorNotice :error="error" />
    <ConfirmDialog
      v-if="confirming"
      :title="t('vault.icons.remove')"
      :text="t('vault.icons.confirm', { count: unused })"
      :confirm="t('vault.icons.removeConfirm')"
      danger
      :busy="busy"
      @confirm="remove"
      @close="confirming = false"
    />
  </section>
</template>

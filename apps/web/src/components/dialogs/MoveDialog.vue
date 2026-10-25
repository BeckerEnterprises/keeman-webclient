<script setup lang="ts">
/**
 * "Move to…", the keyboard alternative to drag and drop: every
 * group of every vault as a radio group, arrows move, Enter moves.
 */
import type { ItemRef, MoveTarget, VaultView } from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useVaultsStore } from "../../stores/vaults";
import AppDialog from "../ui/AppDialog.vue";
import GroupPicker from "./GroupPicker.vue";

const props = defineProps<{ vaultId: string; items: ItemRef[] }>();
const emit = defineEmits<{ move: [target: MoveTarget]; close: [] }>();
const { t } = useI18n();
const vaults = useVaultsStore();
const chosen = ref<string>();

function allowed(vault: VaultView, groupId: string): boolean {
  return vaults
    .engine()
    .canMove(props.vaultId, props.items, { vaultId: vault.id, groupId }).ok;
}

/** Entries whose references break in another vault. */
const brokenRefs = computed(() =>
  vaults.engine().brokenReferences(props.vaultId, props.items),
);

const target = computed(() => {
  const [vaultId = "", groupId = ""] = (chosen.value ?? "").split("/");
  const vault = vaults.vaults.find((v) => v.id === vaultId);
  return vault && allowed(vault, groupId) ? { vault, groupId } : undefined;
});

function move(): void {
  const option = target.value;
  if (option)
    emit("move", { vaultId: option.vault.id, groupId: option.groupId });
}
</script>

<template>
  <AppDialog :title="t('moveDialog.title')" wide @close="emit('close')">
    <div data-test="move-dialog">
      <GroupPicker
        v-model="chosen"
        :vaults="vaults.vaults"
        :allowed="allowed"
        :legend="t('moveDialog.target')"
        test-id="move-option"
        @confirm="move"
      />
    </div>
    <p
      v-if="target && target.vault.id !== vaultId"
      class="notice notice-warning"
      data-test="move-across"
    >
      {{
        target.vault.memberCount > 1
          ? t("moveDialog.acrossShared")
          : t("moveDialog.across")
      }}
    </p>
    <p
      v-if="target && target.vault.id !== vaultId && brokenRefs > 0"
      class="notice notice-warning"
      data-test="move-refs"
    >
      {{ t("moveDialog.brokenRefs", { count: brokenRefs }) }}
    </p>
    <template #actions>
      <button
        type="button"
        :disabled="!target"
        data-test="move-confirm"
        @click="move"
      >
        {{ t("moveDialog.move") }}
      </button>
      <button type="button" class="secondary" @click="emit('close')">
        {{ t("common.cancel") }}
      </button>
    </template>
  </AppDialog>
</template>

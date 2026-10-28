<script setup lang="ts">
/** "Check a member's code" for a database. */
import type { MemberView } from "@keeman/core";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import AppDialog from "../ui/AppDialog.vue";
import StateComparePanel from "./StateComparePanel.vue";

defineProps<{ vaultId: string; members: readonly MemberView[] }>();
const emit = defineEmits<{ changed: []; close: [] }>();
const { t } = useI18n();
const panel = ref<InstanceType<typeof StateComparePanel>>();
</script>

<template>
  <AppDialog
    :title="t('stateCode.compareTitle')"
    wide
    data-test="state-compare-dialog"
    @close="emit('close')"
    @paste="(event: ClipboardEvent) => panel?.onPaste(event)"
  >
    <p class="muted">{{ t("stateCode.compareIntro") }}</p>
    <StateComparePanel
      ref="panel"
      :vault-id="vaultId"
      mode="vault"
      :members="members"
      @changed="emit('changed')"
    />
    <template #actions>
      <button
        type="button"
        class="secondary"
        data-test="state-compare-close"
        @click="emit('close')"
      >
        {{ t("common.close") }}
      </button>
    </template>
  </AppDialog>
</template>

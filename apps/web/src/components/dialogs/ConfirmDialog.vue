<script setup lang="ts">
/** A yes/no question; the confirming button may be dangerous. */
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";
import AppDialog from "../ui/AppDialog.vue";

defineProps<{
  title: string;
  text: string;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{ confirm: []; close: [] }>();
const { t } = useI18n();

onMounted(() =>
  document.querySelector<HTMLButtonElement>("[data-test=confirm-yes]")?.focus(),
);
</script>

<template>
  <AppDialog :title="title" @close="emit('close')">
    <p data-test="confirm-text">{{ text }}</p>
    <template #actions>
      <button
        type="button"
        :class="{ danger }"
        :disabled="busy"
        data-test="confirm-yes"
        @click="emit('confirm')"
      >
        {{ confirm }}
      </button>
      <button
        type="button"
        class="secondary"
        data-test="confirm-no"
        @click="emit('close')"
      >
        {{ t("common.cancel") }}
      </button>
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const toasts = useToastStore();
</script>

<template>
  <div class="toasts" role="status" aria-live="polite" data-test="toasts">
    <p
      v-for="toast in toasts.toasts"
      :key="toast.id"
      class="toast"
      data-test="toast"
    >
      {{ t(toast.key, toast.values) }}
    </p>
  </div>
</template>

<script setup lang="ts">
/** What a conflict did to a change. */
import { useI18n } from "vue-i18n";

defineProps<{ notices: { key: string; values: Record<string, string> }[] }>();
const { t } = useI18n();
</script>

<template>
  <ul
    v-if="notices.length > 0"
    class="notice notice-warning plain-list"
    role="status"
    data-test="write-notices"
  >
    <li v-for="(notice, index) in notices" :key="index">
      {{ t(notice.key, notice.values) }}
    </li>
  </ul>
</template>

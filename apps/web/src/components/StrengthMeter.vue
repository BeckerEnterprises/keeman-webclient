<script setup lang="ts">
import { useI18n } from "vue-i18n";

defineProps<{
  score: number | undefined;
  state: "loading" | "ready" | "failed";
}>();
const { t } = useI18n();
</script>

<template>
  <div class="strength" aria-live="polite">
    <template v-if="state === 'ready' && score !== undefined">
      <meter min="0" max="4" low="2" high="3" optimum="4" :value="score" />
      <span>{{ t("rules.strength") }}: {{ t(`rules.score${score}`) }}</span>
    </template>
    <span v-else-if="state === 'loading'">{{ t("rules.loading") }}</span>
    <span v-else-if="state === 'failed'" class="text-error">{{
      t("rules.unavailable")
    }}</span>
  </div>
</template>

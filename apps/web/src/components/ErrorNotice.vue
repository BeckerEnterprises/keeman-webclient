<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { UiError } from "../errors";

const props = defineProps<{ error: UiError | undefined }>();
const { t } = useI18n();
const remaining = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;

function stop(): void {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}

watch(
  () => props.error,
  (error) => {
    stop();
    remaining.value = error?.retryAfter ?? 0;
    if (remaining.value > 0)
      timer = setInterval(() => {
        remaining.value = Math.max(0, remaining.value - 1);
        if (remaining.value === 0) stop();
      }, 1000);
  },
  { immediate: true },
);
onBeforeUnmount(stop);

const message = computed(() =>
  props.error
    ? t(`error.${props.error.key}`, { seconds: remaining.value })
    : "",
);

defineExpose({ waiting: computed(() => remaining.value > 0) });
</script>

<template>
  <div v-if="error" class="notice notice-error" role="alert" data-test="error">
    <p>{{ message }}</p>
    <p v-if="error.instance" class="notice-id">
      {{ t("error.errorId", { id: error.instance }) }}
    </p>
  </div>
</template>

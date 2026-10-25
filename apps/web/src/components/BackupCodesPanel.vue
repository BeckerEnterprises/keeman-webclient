<script setup lang="ts">
/**
 * Shows backup codes once: print, no copy button, no download;
 * the page goes on only after "codes saved".
 */
import { useI18n } from "vue-i18n";

defineProps<{ codes: readonly string[] }>();
const emit = defineEmits<{ done: [] }>();
const { t } = useI18n();

function print(): void {
  window.print();
}

/** `ABCDE FGHIJ` reads more easily; spaces are ignored when typed. */
function grouped(code: string): string {
  return `${code.slice(0, 5)} ${code.slice(5)}`;
}
</script>

<template>
  <section class="backup-codes print-area" data-test="backup-codes">
    <h3>{{ t("twoFactor.codesTitle") }}</h3>
    <p>{{ t("twoFactor.codesIntro") }}</p>
    <p class="notice notice-warning">{{ t("twoFactor.codesKeep") }}</p>
    <ol class="backup-code-list mono" :aria-label="t('twoFactor.codesTitle')">
      <li v-for="code in codes" :key="code" data-test="backup-code-item">
        {{ grouped(code) }}
      </li>
    </ol>
    <div class="actions no-print">
      <button type="button" class="secondary" @click="print">
        {{ t("common.print") }}
      </button>
      <button type="button" data-test="backup-codes-done" @click="emit('done')">
        {{ t("twoFactor.codesSaved") }}
      </button>
    </div>
  </section>
</template>

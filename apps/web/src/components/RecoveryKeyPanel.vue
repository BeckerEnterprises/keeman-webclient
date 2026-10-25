<script setup lang="ts">
/** Shows a recovery key once and asks for its last group. */
import { matchesRecoveryKeyGroup } from "@keeman/core";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  recoveryKey: string;
  busy: boolean;
  action: string;
}>();
const emit = defineEmits<{ confirm: [] }>();
const { t } = useI18n();
const typed = ref("");
const wrong = ref(false);
const groups = computed(() => props.recoveryKey.split(" "));

function print(): void {
  window.print();
}

function confirm(): void {
  wrong.value = !matchesRecoveryKeyGroup(props.recoveryKey, typed.value);
  if (!wrong.value) emit("confirm");
}
</script>

<template>
  <section class="recovery print-area" data-test="recovery-key">
    <h2>{{ t("recovery.title") }}</h2>
    <p>{{ t("recovery.intro") }}</p>
    <p class="notice notice-warning">{{ t("recovery.keep") }}</p>
    <ol class="recovery-groups" :aria-label="t('recovery.groups')">
      <li
        v-for="(group, index) in groups"
        :key="index"
        data-test="recovery-group"
      >
        {{ group }}
      </li>
    </ol>
    <div class="no-print">
      <button type="button" class="secondary" @click="print">
        {{ t("common.print") }}
      </button>
      <form class="form" @submit.prevent="confirm">
        <div class="field">
          <label for="recovery-confirm">{{ t("recovery.confirmLabel") }}</label>
          <input
            id="recovery-confirm"
            v-model="typed"
            class="mono"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            maxlength="8"
            required
          />
        </div>
        <p v-if="wrong" class="text-error" role="alert">
          {{ t("recovery.wrong") }}
        </p>
        <button type="submit" :disabled="busy" data-test="recovery-confirm">
          {{ busy ? t("common.working") : action }}
        </button>
      </form>
    </div>
  </section>
</template>

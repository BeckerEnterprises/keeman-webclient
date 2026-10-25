<script setup lang="ts">
/**
 * The TOTP block of the detail: the code in groups, a countdown
 * ring, a click copies; in the last 5 seconds the next code as well. Values
 * this version cannot use get a message instead.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { copySecret } from "../../clipboard";
import { useSessionStore } from "../../stores/session";
import { groupCode, useTotp } from "../../totp";

const props = defineProps<{ vaultId: string; entryId: string }>();
const { t } = useI18n();
const session = useSessionStore();
const { result, remaining } = useTotp(() => ({
  vaultId: props.vaultId,
  entryId: props.entryId,
}));

const RADIUS = 15;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const code = computed(() =>
  result.value?.ok === true ? result.value.value : undefined,
);
const problem = computed(() =>
  result.value?.ok === false ? result.value.problem : undefined,
);
const dashOffset = computed(() => {
  const period = code.value?.period ?? 30;
  return CIRCUMFERENCE * (1 - remaining.value / period);
});

async function copy(value: string): Promise<void> {
  await copySecret(value, session.settings.clipboardClearSeconds);
}
</script>

<template>
  <div v-if="result" class="secret-value totp-block" data-test="totp">
    <dt>{{ t("totp.label") }}</dt>
    <dd v-if="code">
      <button
        type="button"
        class="totp-code mono"
        :aria-label="t('totp.copy')"
        data-test="totp-code"
        :data-code="code.code"
        @click="copy(code.code)"
      >
        <span v-for="(part, index) in groupCode(code.code)" :key="index">{{
          part
        }}</span>
      </button>
      <svg
        class="totp-ring"
        viewBox="0 0 36 36"
        width="28"
        height="28"
        role="img"
        :aria-label="t('totp.remaining', { seconds: remaining })"
        data-test="totp-ring"
      >
        <circle class="totp-ring-track" cx="18" cy="18" :r="RADIUS" />
        <circle
          class="totp-ring-progress"
          cx="18"
          cy="18"
          :r="RADIUS"
          :stroke-dasharray="CIRCUMFERENCE"
          :stroke-dashoffset="dashOffset"
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span class="totp-seconds muted" aria-hidden="true">{{ remaining }}</span>
      <button
        v-if="remaining <= 5"
        type="button"
        class="link totp-next mono"
        :aria-label="t('totp.copyNext')"
        data-test="totp-next"
        @click="copy(code.next)"
      >
        {{ t("totp.next") }} {{ groupCode(code.next).join(" ") }}
      </button>
    </dd>
    <dd v-else class="text-warning" data-test="totp-problem">
      {{
        problem === "hotp" || problem === "steam"
          ? t("totp.unsupported", { type: t(`totp.kinds.${problem}`) })
          : t("totp.invalid")
      }}
    </dd>
  </div>
</template>

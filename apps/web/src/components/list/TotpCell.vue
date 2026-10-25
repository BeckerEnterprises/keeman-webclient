<script setup lang="ts">
/**
 * A cell of the TOTP column: the live code with the seconds left,
 * a click copies. Only rendered rows exist, so only they ask for codes.
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
const code = computed(() =>
  result.value?.ok === true ? result.value.value.code : undefined,
);

async function copy(): Promise<void> {
  if (code.value !== undefined)
    await copySecret(code.value, session.settings.clipboardClearSeconds);
}
</script>

<template>
  <button
    v-if="code"
    type="button"
    class="link totp-cell mono"
    :aria-label="t('totp.copy')"
    data-test="totp-cell"
    :data-code="code"
    @click.stop="copy"
    @dblclick.stop
  >
    {{ groupCode(code).join(" ") }}
    <span class="muted totp-cell-seconds">{{ remaining }}</span>
  </button>
  <span
    v-else-if="result?.ok === false"
    class="text-warning"
    :title="t('totp.invalid')"
    >!</span
  >
</template>

<script setup lang="ts">
/**
 * A value with copy button; secrets are masked with an eye to show them.
 * A value from a `{REF}` is marked as such, with the hints of
 * its resolution. Vault content is shown as text only.
 */
import type { PlaceholderWarning } from "@keeman/core";
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { copySecret } from "../../clipboard";
import { useSessionStore } from "../../stores/session";
import AppIcon from "./AppIcon";

const props = defineProps<{
  label: string;
  value: string;
  secret?: boolean;
  /** The stored value contains a `{REF}`. */
  reference?: boolean;
  warnings?: readonly PlaceholderWarning[];
  test?: string;
}>();
const { t } = useI18n();
const session = useSessionStore();
const shown = ref(false);

async function copy(): Promise<void> {
  await copySecret(props.value, session.settings.clipboardClearSeconds);
}
</script>

<template>
  <div class="secret-value" :data-test="test">
    <dt>
      {{ label
      }}<span
        v-if="reference"
        class="tag"
        :data-test="test ? `${test}-ref` : undefined"
        >{{ t("entry.reference") }}</span
      >
    </dt>
    <dd>
      <span
        class="value"
        :class="{ masked: secret && !shown, mono: secret }"
        :data-test="test ? `${test}-value` : undefined"
        >{{ secret && !shown ? "••••••••••••" : value }}</span
      >
      <button
        v-if="secret"
        type="button"
        class="icon-button"
        :aria-label="
          shown
            ? t('entry.hide', { field: label })
            : t('entry.show', { field: label })
        "
        :aria-pressed="shown"
        :data-test="test ? `${test}-show` : undefined"
        @click="shown = !shown"
      >
        <AppIcon :ui="shown ? 'eyeOff' : 'eye'" />
      </button>
      <button
        type="button"
        class="icon-button"
        :aria-label="t('entry.copy', { field: label })"
        :disabled="value === ''"
        :data-test="test ? `${test}-copy` : undefined"
        @click="copy"
      >
        <AppIcon ui="copy" />
      </button>
    </dd>
    <dd
      v-for="warning in warnings ?? []"
      :key="warning"
      class="url-note text-warning"
      :data-test="test ? `${test}-${warning}` : undefined"
    >
      <AppIcon ui="warning" /> {{ t(`entry.refWarning.${warning}`) }}
    </dd>
  </div>
</template>

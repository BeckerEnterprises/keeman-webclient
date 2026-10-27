<script setup lang="ts">
/**
 * "The server is withholding data": what was delivered does not match the
 * vault manifest. "Understood" asks first, then accepts the delivered
 * state and rewrites the manifest.
 */
import type { VaultView } from "@keeman/core";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{ vault: VaultView; busy?: boolean }>();
const emit = defineEmits<{ acknowledge: [] }>();
const { t } = useI18n();

const counts = computed(() => {
  const by = new Map<string, number>();
  for (const issue of props.vault.manifestIssues)
    by.set(issue.reason, (by.get(issue.reason) ?? 0) + 1);
  return (["missing", "differs", "unlisted", "corrupt"] as const)
    .filter((reason) => by.has(reason))
    .map((reason) => ({ reason, count: by.get(reason) ?? 0 }));
});

function acknowledge(): void {
  if (window.confirm(t("vaults.manifest.confirm"))) emit("acknowledge");
}
</script>

<template>
  <div
    v-if="vault.manifest === 'mismatch'"
    class="notice notice-error"
    role="alert"
    data-test="vault-manifest"
  >
    <p>{{ t("vaults.manifest.withheld") }}</p>
    <ul class="plain-list" data-test="vault-manifest-counts">
      <li v-for="item in counts" :key="item.reason">
        {{ t(`vaults.manifest.${item.reason}`, { count: item.count }) }}
      </li>
    </ul>
    <button
      type="button"
      class="small"
      data-test="vault-manifest-ack"
      :disabled="busy"
      @click="acknowledge"
    >
      {{ t("common.understood") }}
    </button>
  </div>
</template>

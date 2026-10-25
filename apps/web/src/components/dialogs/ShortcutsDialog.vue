<script setup lang="ts">
/** The keyboard shortcuts that are registered right now. */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { shortcutList, type Combo } from "../../shortcuts";
import AppDialog from "../ui/AppDialog.vue";

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

function keys(combo: Combo): string {
  const key =
    combo.key.length === 1
      ? combo.key.toUpperCase()
      : t(`shortcuts.keys.${combo.key}`, combo.key);
  return [combo.ctrl ? "Ctrl" : "", combo.shift ? "Shift" : "", key]
    .filter(Boolean)
    .join("+");
}

const rows = computed(() => {
  // Ctrl+C works through the copy event, not the dispatcher.
  const seen = new Map<string, string[]>([
    ["shortcuts.copyPassword", ["Ctrl+C"]],
  ]);
  for (const s of shortcutList()) {
    const label = s.label ?? "";
    seen.set(label, [...(seen.get(label) ?? []), ...s.combos.map(keys)]);
  }
  return [...seen].map(([label, combos]) => ({
    label,
    combos: [...new Set(combos)],
  }));
});
</script>

<template>
  <AppDialog :title="t('shortcuts.title')" @close="emit('close')">
    <table class="shortcut-table" data-test="shortcuts">
      <tbody>
        <tr v-for="row in rows" :key="row.label">
          <td>{{ t(row.label) }}</td>
          <td>
            <kbd v-for="combo in row.combos" :key="combo">{{ combo }}</kbd>
          </td>
        </tr>
      </tbody>
    </table>
    <template #actions>
      <button type="button" data-test="shortcuts-close" @click="emit('close')">
        {{ t("common.close") }}
      </button>
    </template>
  </AppDialog>
</template>

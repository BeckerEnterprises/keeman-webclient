<script setup lang="ts">
/**
 * The groups of some vaults as a radio group: arrows move, Enter
 * confirms. Recycle bins and their content are left out. The model is
 * `<vaultId>/<groupId>`; the first allowed group is chosen at the start.
 */
import type { VaultView } from "@keeman/core";
import { computed, onMounted, useId } from "vue";
import { useI18n } from "vue-i18n";
import { customIconSrc } from "../../custom-icons";
import AppIcon from "../ui/AppIcon";

const props = defineProps<{
  vaults: readonly VaultView[];
  allowed: (vault: VaultView, groupId: string) => boolean;
  legend: string;
  /** `data-test` of the radio buttons. */
  testId: string;
}>();
const emit = defineEmits<{ confirm: [] }>();
const chosen = defineModel<string>();
const { t } = useI18n();
const name = useId();

interface Option {
  key: string;
  label: string;
  depth: number;
  icon: string;
  src: string | undefined;
  allowed: boolean;
}

const options = computed<Option[]>(() => {
  const list: Option[] = [];
  for (const vault of props.vaults) {
    const walk = (id: string, depth: number) => {
      const node = vault.tree.nodes.get(id);
      if (!node || node.kind === "bin" || node.inTrash) return;
      list.push({
        key: `${vault.id}/${id}`,
        label:
          node.kind === "root"
            ? (vault.name ?? t("vaults.unnamed"))
            : node.name,
        depth,
        icon: node.icon,
        src: customIconSrc(vault, node.customIcon),
        allowed: props.allowed(vault, id),
      });
      for (const child of node.children) walk(child, depth + 1);
    };
    walk(vault.tree.rootId, 0);
  }
  return list;
});

onMounted(() => {
  if (!options.value.some((o) => o.key === chosen.value && o.allowed))
    chosen.value = options.value.find((o) => o.allowed)?.key;
  document
    .querySelector<HTMLInputElement>(`[data-test=${props.testId}]:checked`)
    ?.focus();
});
</script>

<template>
  <fieldset class="move-options" @keydown.enter.prevent="emit('confirm')">
    <legend class="sr-only">{{ legend }}</legend>
    <label
      v-for="option in options"
      :key="option.key"
      class="move-option"
      :class="{ disabled: !option.allowed }"
      :style="{ paddingInlineStart: `${option.depth * 1.1 + 0.25}rem` }"
    >
      <input
        v-model="chosen"
        type="radio"
        :name="name"
        :value="option.key"
        :disabled="!option.allowed"
        :data-test="testId"
      />
      <AppIcon :name="option.icon" :src="option.src" />
      <span>{{ option.label }}</span>
    </label>
  </fieldset>
</template>

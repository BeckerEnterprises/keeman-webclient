<script setup lang="ts">
/** New group or its properties: name, icon, default entry icon, notes. */
import type { IconRef, TreeNode } from "@keeman/core";
import { onMounted, ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import AppDialog from "../ui/AppDialog.vue";
import IconPicker from "../ui/IconPicker.vue";

const props = defineProps<{
  vaultId: string;
  node?: TreeNode;
  busy: boolean;
}>();
const emit = defineEmits<{
  save: [
    props: {
      name: string;
      icon: IconRef | null;
      defaultEntryIcon: IconRef | null;
      notes: string;
    },
  ];
  close: [];
}>();
const { t } = useI18n();
const ids = { name: useId(), notes: useId() };
const name = ref(props.node?.name ?? "");
const icon = ref<IconRef | null>(props.node?.iconRef ?? null);
const defaultEntryIcon = ref<IconRef | null>(
  props.node?.defaultEntryIcon ?? null,
);
const notes = ref(props.node?.notes ?? "");
const invalid = ref(false);

function save(): void {
  const trimmed = name.value.trim();
  invalid.value = trimmed === "" || Array.from(trimmed).length > 256;
  if (invalid.value) return;
  emit("save", {
    name: trimmed,
    icon: icon.value ?? { type: "builtin", name: "folder" },
    defaultEntryIcon: defaultEntryIcon.value,
    notes: notes.value,
  });
}

onMounted(() => document.getElementById(ids.name)?.focus());
</script>

<template>
  <AppDialog
    :title="node ? t('groupDialog.edit') : t('groupDialog.new')"
    wide
    @close="emit('close')"
  >
    <div class="form" data-test="group-dialog">
      <div class="field">
        <label :for="ids.name">{{ t("groupDialog.name") }}</label>
        <input
          :id="ids.name"
          v-model="name"
          maxlength="256"
          data-test="group-dialog-name"
          @keydown.enter.prevent="save"
        />
        <p v-if="invalid" class="text-error small-text">
          {{ t("error.sync_invalid_name") }}
        </p>
      </div>
      <IconPicker
        v-model="icon"
        :label="t('groupDialog.icon')"
        fallback="folder"
        :vault-id="vaultId"
      />
      <IconPicker
        v-model="defaultEntryIcon"
        :label="t('groupDialog.defaultEntryIcon')"
        :none-label="t('groupDialog.inherit')"
        fallback="key-round"
        :vault-id="vaultId"
      />
      <div class="field">
        <label :for="ids.notes">{{ t("entry.notes") }}</label>
        <textarea
          :id="ids.notes"
          v-model="notes"
          rows="3"
          data-test="group-dialog-notes"
        ></textarea>
      </div>
    </div>
    <template #actions>
      <button
        type="button"
        :disabled="busy"
        data-test="group-dialog-save"
        @click="save"
      >
        {{ t("common.save") }}
      </button>
      <button type="button" class="secondary" @click="emit('close')">
        {{ t("common.cancel") }}
      </button>
    </template>
  </AppDialog>
</template>

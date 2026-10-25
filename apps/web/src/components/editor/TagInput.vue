<script setup lang="ts">
/** Tags as removable chips; Enter or comma adds one. */
import { ref, useId } from "vue";
import { useI18n } from "vue-i18n";
import AppIcon from "../ui/AppIcon";

defineProps<{ invalid: ReadonlySet<number> }>();
const tags = defineModel<string[]>({ required: true });
const { t } = useI18n();
const text = ref("");
const id = useId();

function add(): void {
  const value = text.value.trim();
  if (value !== "") tags.value = [...tags.value, value];
  text.value = "";
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" || event.key === ",") {
    event.preventDefault();
    event.stopPropagation();
    add();
  } else if (
    event.key === "Backspace" &&
    text.value === "" &&
    tags.value.length > 0
  ) {
    tags.value = tags.value.slice(0, -1);
  }
}
</script>

<template>
  <div class="field">
    <label :for="id">{{ t("entry.tags") }}</label>
    <div class="tag-input">
      <span
        v-for="(tag, index) in tags"
        :key="`${index}-${tag}`"
        class="tag"
        :class="{ 'tag-invalid': invalid.has(index) }"
        data-test="editor-tag"
      >
        {{ tag }}
        <button
          type="button"
          class="icon-button tiny"
          :aria-label="t('editor.removeTag', { tag })"
          @click="tags = tags.filter((_, i) => i !== index)"
        >
          <AppIcon ui="close" :size="12" />
        </button>
      </span>
      <input
        :id="id"
        v-model="text"
        :placeholder="t('editor.addTag')"
        data-test="editor-tag-input"
        @keydown="onKeydown"
        @blur="add"
      />
    </div>
  </div>
</template>

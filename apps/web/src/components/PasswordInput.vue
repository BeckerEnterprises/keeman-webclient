<script setup lang="ts">
/**
 * Password field that is not bound to reactive state: the value is
 * read on submit and cleared afterwards.
 */
import { ref, useId } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{
  label: string;
  /** `off` for KDBX passwords, which the browser should not offer to save. */
  autocomplete: "current-password" | "new-password" | "off";
  name: string;
  /** A KDBX file may need only a key file. */
  optional?: boolean;
}>();
const emit = defineEmits<{ input: [value: string] }>();
const { t } = useI18n();
const id = useId();
const field = ref<HTMLInputElement>();
const visible = ref(false);

function onInput(event: Event): void {
  emit("input", (event.target as HTMLInputElement).value);
}

defineExpose({
  value: (): string => field.value?.value ?? "",
  clear: (): void => {
    if (field.value) field.value.value = "";
    visible.value = false;
  },
  focus: (): void => field.value?.focus(),
});
</script>

<template>
  <div class="field">
    <label :for="id">{{ label }}</label>
    <div class="password-row">
      <input
        :id="id"
        ref="field"
        :name="name"
        :type="visible ? 'text' : 'password'"
        :autocomplete="autocomplete"
        autocapitalize="off"
        spellcheck="false"
        :required="!props.optional"
        @input="onInput"
      />
      <button
        type="button"
        class="secondary small"
        :aria-pressed="visible"
        @click="visible = !visible"
      >
        {{ visible ? t("common.hide") : t("common.show") }}
      </button>
    </div>
  </div>
</template>

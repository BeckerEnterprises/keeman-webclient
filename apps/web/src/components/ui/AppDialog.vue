<script setup lang="ts">
/**
 * A modal native `<dialog>`: Escape closes, the focus returns to where it
 * was. Only one dialog is open at a time.
 */
import { onBeforeUnmount, onMounted, ref, useId } from "vue";

defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const id = useId();
let previous: Element | null = null;

onMounted(() => {
  previous = document.activeElement;
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  if (dialog.value?.open) dialog.value.close();
  if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="dialog"
    :class="{ 'dialog-wide': wide }"
    :aria-labelledby="id"
    @cancel.prevent="emit('close')"
  >
    <h2 :id="id">{{ title }}</h2>
    <slot />
    <div class="actions dialog-actions">
      <slot name="actions" />
    </div>
  </dialog>
</template>

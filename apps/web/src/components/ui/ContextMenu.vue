<script setup lang="ts">
/** A menu at a point: arrow keys, Escape, click outside closes. */
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import AppIcon from "./AppIcon";
import type { MenuItem } from "./menu";

const props = defineProps<{
  items: MenuItem[];
  x: number;
  y: number;
  label: string;
}>();
const emit = defineEmits<{ select: [key: string]; close: [] }>();
const menu = ref<HTMLElement>();
let previous: Element | null = null;

function buttons(): HTMLButtonElement[] {
  return Array.from(
    menu.value?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ??
      [],
  );
}

function move(step: number): void {
  const list = buttons();
  const index = list.indexOf(document.activeElement as HTMLButtonElement);
  list[(index + step + list.length) % list.length]?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  const list = buttons();
  if (event.key === "ArrowDown") move(1);
  else if (event.key === "ArrowUp") move(-1);
  else if (event.key === "Home") list[0]?.focus();
  else if (event.key === "End") list.at(-1)?.focus();
  else if (event.key === "Escape" || event.key === "Tab") emit("close");
  else return;
  event.preventDefault();
  event.stopPropagation();
}

function outside(event: PointerEvent): void {
  if (!menu.value?.contains(event.target as Node)) emit("close");
}

function choose(item: MenuItem): void {
  if (!item.disabled) emit("select", item.key);
}

onMounted(async () => {
  previous = document.activeElement;
  window.addEventListener("pointerdown", outside, true);
  await nextTick();
  // Keep the menu inside the window.
  const box = menu.value?.getBoundingClientRect();
  if (menu.value && box) {
    menu.value.style.left = `${String(Math.max(4, Math.min(props.x, window.innerWidth - box.width - 4)))}px`;
    menu.value.style.top = `${String(Math.max(4, Math.min(props.y, window.innerHeight - box.height - 4)))}px`;
  }
  buttons()[0]?.focus();
});
onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", outside, true);
  if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
});
</script>

<template>
  <div
    ref="menu"
    class="context-menu"
    role="menu"
    :aria-label="label"
    data-test="context-menu"
    @keydown="onKeydown"
  >
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      role="menuitem"
      class="menu-item"
      :class="{ 'menu-danger': item.danger }"
      :disabled="item.disabled"
      :data-test="`menu-${item.key}`"
      @click="choose(item)"
    >
      <AppIcon v-if="item.ui" :ui="item.ui" />
      <span>{{ item.label }}</span>
    </button>
  </div>
</template>

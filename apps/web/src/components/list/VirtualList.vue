<script setup lang="ts" generic="T">
/**
 * Renders only the rows in view plus a margin; the active row is
 * always rendered so it can keep the focus. Rows have one fixed height,
 * measured from the first rendered row.
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";

const props = defineProps<{
  items: readonly T[];
  itemKey: (item: T) => string;
  /** Index that must stay rendered (focus). */
  active?: number;
}>();

const MARGIN = 10;
const scroller = ref<HTMLElement>();
const rowHeight = ref(34);
const scrollTop = ref(0);
const height = ref(600);
let observer: ResizeObserver | undefined;

const visible = computed(() => {
  const first = Math.max(
    0,
    Math.floor(scrollTop.value / rowHeight.value) - MARGIN,
  );
  const last = Math.min(
    props.items.length,
    Math.ceil((scrollTop.value + height.value) / rowHeight.value) + MARGIN,
  );
  const indexes: number[] = [];
  for (let i = first; i < last; i++) indexes.push(i);
  const active = props.active;
  if (
    active !== undefined &&
    active >= 0 &&
    active < props.items.length &&
    (active < first || active >= last)
  )
    indexes.push(active);
  return indexes;
});

function measure(): void {
  const element = scroller.value;
  if (!element) return;
  height.value = element.clientHeight || height.value;
  const row = element.querySelector<HTMLElement>(".virtual-row");
  if (row && row.offsetHeight > 0) rowHeight.value = row.offsetHeight;
}

function onScroll(): void {
  scrollTop.value = scroller.value?.scrollTop ?? 0;
}

/** Scrolls the minimum needed to show row `index`. */
function scrollToIndex(index: number): void {
  const element = scroller.value;
  if (!element) return;
  const top = index * rowHeight.value;
  if (top < element.scrollTop) element.scrollTop = top;
  else if (top + rowHeight.value > element.scrollTop + element.clientHeight)
    element.scrollTop = top + rowHeight.value - element.clientHeight;
  onScroll();
}

onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);
  if (scroller.value) observer.observe(scroller.value);
});
onBeforeUnmount(() => observer?.disconnect());
watch(
  () => props.items.length,
  () => void nextTick(measure),
);

defineExpose({ scrollToIndex });
</script>

<template>
  <div
    ref="scroller"
    class="virtual-scroller"
    role="rowgroup"
    @scroll="onScroll"
  >
    <div
      class="virtual-spacer"
      role="none"
      :style="{ height: `${items.length * rowHeight}px` }"
    >
      <div
        v-for="index in visible"
        :key="itemKey(items[index] as T)"
        class="virtual-row"
        role="none"
        :style="{ transform: `translateY(${index * rowHeight}px)` }"
      >
        <slot :item="items[index] as T" :index="index" />
      </div>
    </div>
  </div>
</template>

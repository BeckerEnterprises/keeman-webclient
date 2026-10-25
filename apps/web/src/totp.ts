/**
 * TOTP in the UI: one shared tick per second in server time,
 * codes fetched from the core per entry and again when their
 * time step ends, and the grouping of the digits.
 */
import type { TotpResult } from "@keeman/core";
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  type Ref,
} from "vue";
import { useVaultsStore } from "./stores/vaults";

const now = ref(Date.now());
let listeners = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function serverNow(): number {
  try {
    return useVaultsStore().engine().serverNow();
  } catch {
    return Date.now();
  }
}

/** Ticks just after each full server second. */
function tick(): void {
  now.value = serverNow();
  timer = setTimeout(tick, 1000 - (now.value % 1000) + 10);
}

/** The server time in ms, updated every second while anyone listens. */
export function useServerClock(): Ref<number> {
  onMounted(() => {
    listeners++;
    if (listeners === 1) tick();
  });
  onBeforeUnmount(() => {
    listeners--;
    if (listeners === 0 && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  });
  return now;
}

/** 6 digits 3+3, 7 digits 3+4, 8 digits 4+4. */
export function groupCode(code: string): string[] {
  const head = Math.floor(code.length / 2);
  return [code.slice(0, head), code.slice(head)].filter((p) => p !== "");
}

/**
 * The codes of one entry; `undefined` without `otp` or while locked. The
 * code is fetched again when its step ends or the vault changes.
 */
export function useTotp(
  target: () => { vaultId: string; entryId: string } | undefined,
) {
  const vaults = useVaultsStore();
  const clock = useServerClock();
  const result = shallowRef<TotpResult>();
  let request = 0;

  async function load(): Promise<void> {
    const current = target();
    const id = ++request;
    let next: TotpResult | undefined;
    try {
      next = current
        ? await vaults.engine().totp(current.vaultId, current.entryId)
        : undefined;
    } catch {
      next = undefined;
    }
    if (id === request) result.value = next;
  }

  watch(
    () => {
      const current = target();
      return current ? `${current.vaultId}/${current.entryId}` : "";
    },
    () => void load(),
    { immediate: true },
  );
  watch(
    () => vaults.snapshot,
    () => void load(),
  );
  watch(clock, (time) => {
    const current = result.value;
    if (current?.ok === true && time >= current.value.validUntil) void load();
  });

  const remaining = computed(() => {
    const current = result.value;
    return current?.ok === true
      ? Math.max(0, Math.ceil((current.value.validUntil - clock.value) / 1000))
      : 0;
  });
  return { result, remaining };
}

/**
 * Auto-lock of this tab: inactivity, timer jumps (device sleep) and
 * hidden tabs. Runs on the main thread with a 10 s tick.
 */
export interface AutoLockSettings {
  autoLockMinutes: number;
  lockOnHiddenMinutes: number | null;
}

export const TICK_MS = 10_000;
export const JUMP_VISIBLE_MS = 60_000;
export const JUMP_HIDDEN_MS = 180_000;

export interface AutoLockState {
  lastActivity: number;
  lastTick: number;
  hiddenSince: number | undefined;
}

export type LockReason = "inactive" | "sleep" | "hidden";

/** Pure decision, testable without timers. */
export function lockReason(
  state: AutoLockState,
  now: number,
  hidden: boolean,
  settings: AutoLockSettings,
): LockReason | undefined {
  if (now - state.lastTick > (hidden ? JUMP_HIDDEN_MS : JUMP_VISIBLE_MS))
    return "sleep";
  if (now - state.lastActivity >= settings.autoLockMinutes * 60_000)
    return "inactive";
  if (
    settings.lockOnHiddenMinutes !== null &&
    state.hiddenSince !== undefined &&
    now - state.hiddenSince >= settings.lockOnHiddenMinutes * 60_000
  )
    return "hidden";
  return undefined;
}

const ACTIVITY_EVENTS = [
  "keydown",
  "pointerdown",
  "wheel",
  "touchstart",
] as const;

export class AutoLock {
  readonly #onLock: (reason: LockReason) => void;
  #settings: AutoLockSettings = {
    autoLockMinutes: 15,
    lockOnHiddenMinutes: null,
  };
  #state: AutoLockState = {
    lastActivity: 0,
    lastTick: 0,
    hiddenSince: undefined,
  };
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #activity = (): void => {
    this.#state.lastActivity = Date.now();
  };
  readonly #visibility = (): void => {
    if (document.visibilityState === "hidden")
      this.#state.hiddenSince ??= Date.now();
    // Judged with the hidden thresholds: timers of hidden tabs are throttled.
    this.#check();
    if (document.visibilityState === "visible") {
      this.#state.hiddenSince = undefined;
      this.#state.lastTick = Date.now();
    }
  };
  readonly #recheck = (): void => {
    this.#check();
  };
  readonly #pageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) this.#lock("sleep");
    else this.#check();
  };

  constructor(onLock: (reason: LockReason) => void) {
    this.#onLock = onLock;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  /** Work without input that still counts as activity, e.g. an import. */
  markActivity(): void {
    this.#activity();
  }

  start(settings: AutoLockSettings): void {
    this.stop();
    this.#settings = settings;
    const now = Date.now();
    this.#state = {
      lastActivity: now,
      lastTick: now,
      hiddenSince: document.visibilityState === "hidden" ? now : undefined,
    };
    for (const name of ACTIVITY_EVENTS)
      window.addEventListener(name, this.#activity, {
        capture: true,
        passive: true,
      });
    document.addEventListener("visibilitychange", this.#visibility);
    window.addEventListener("focus", this.#recheck);
    document.addEventListener("resume", this.#recheck);
    window.addEventListener("pageshow", this.#pageShow);
    this.#timer = setInterval(() => {
      this.#check();
      this.#state.lastTick = Date.now();
    }, TICK_MS);
  }

  update(settings: AutoLockSettings): void {
    this.#settings = settings;
    this.#check();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const name of ACTIVITY_EVENTS)
      window.removeEventListener(name, this.#activity, { capture: true });
    document.removeEventListener("visibilitychange", this.#visibility);
    window.removeEventListener("focus", this.#recheck);
    document.removeEventListener("resume", this.#recheck);
    window.removeEventListener("pageshow", this.#pageShow);
  }

  #check(): void {
    if (this.#timer === undefined) return;
    const reason = lockReason(
      this.#state,
      Date.now(),
      document.visibilityState === "hidden" ||
        this.#state.hiddenSince !== undefined,
      this.#settings,
    );
    if (reason) this.#lock(reason);
  }

  #lock(reason: LockReason): void {
    this.stop();
    this.#onLock(reason);
  }
}

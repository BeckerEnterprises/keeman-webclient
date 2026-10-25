/**
 * Server time for TOTP: the offset is the server's `now_ms`
 * minus the middle of sending and receiving, measured at the start and
 * every 10 minutes. A failed measurement keeps the last value.
 */
import type { Timers } from "../sync/events";

export const CLOCK_INTERVAL_MS = 10 * 60 * 1000;
/** Above this, the UI points out the difference. */
export const CLOCK_SKEW_HINT_MS = 30_000;

export interface TotpClockOptions {
  time: () => Promise<{ now_ms: number }>;
  timers: Timers;
  now?: () => number;
  /** Called after a measurement changed the offset. */
  onChange?: () => void;
}

export class TotpClock {
  readonly #time: () => Promise<{ now_ms: number }>;
  readonly #timers: Timers;
  readonly #now: () => number;
  readonly #onChange: () => void;
  #offset = 0;
  #timer: unknown;
  #running = false;

  constructor(options: TotpClockOptions) {
    this.#time = options.time;
    this.#timers = options.timers;
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange ?? (() => undefined);
  }

  /** Server time minus local time, in ms. */
  get offset(): number {
    return this.#offset;
  }

  /** The current server time in ms. */
  now(): number {
    return this.#now() + this.#offset;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.measure();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** One measurement; schedules the next while running. */
  async measure(): Promise<void> {
    const sent = this.#now();
    try {
      const { now_ms: server } = await this.#time();
      const received = this.#now();
      if (!this.#running) return;
      const offset = Math.round(server - (sent + received) / 2);
      if (offset !== this.#offset) {
        this.#offset = offset;
        this.#onChange();
      }
    } catch {
      // Keep the last value.
    } finally {
      if (this.#running) {
        if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
        this.#timer = this.#timers.setTimeout(() => {
          void this.measure();
        }, CLOCK_INTERVAL_MS);
      }
    }
  }
}

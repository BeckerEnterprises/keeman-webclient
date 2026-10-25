/** Runs a task one at a time; a request during a run causes exactly one more run. */
export class Serial {
  #running: Promise<void> | undefined;
  #again = false;

  run(task: () => Promise<void>): Promise<void> {
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await task();
        } while (this.#requested());
      } finally {
        this.#running = undefined;
      }
    })();
    return this.#running;
  }

  /** Read through a method: the flag changes while `task` awaits. */
  #requested(): boolean {
    return this.#again;
  }
}

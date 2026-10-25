import { describe, expect, it } from "vitest";
import { CLOCK_INTERVAL_MS, TotpClock } from "../../src/totp/clock";

function fakeTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    timers: {
      setTimeout: (run: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { run, ms });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    fire() {
      const [first] = pending;
      if (!first) throw new Error("no timer");
      pending.delete(first[0]);
      first[1].run();
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TOTP clock", () => {
  it("takes the middle of the round trip and measures every 10 minutes", async () => {
    let local = 1_000_000;
    const answers: (() => Promise<{ now_ms: number }>)[] = [
      () => {
        local += 200; // 200 ms round trip
        return Promise.resolve({ now_ms: 1_090_100 });
      },
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve({ now_ms: local - 5000 }),
    ];
    const timers = fakeTimers();
    let changes = 0;
    const clock = new TotpClock({
      time: () => {
        const answer = answers.shift();
        if (!answer) throw new Error("no answer");
        return answer();
      },
      timers: timers.timers,
      now: () => local,
      onChange: () => changes++,
    });
    expect(clock.offset).toBe(0);
    clock.start();
    clock.start();
    await flush();
    // Sent at 1 000 000, received at 1 000 200: the middle is 1 000 100.
    expect(clock.offset).toBe(90_000);
    expect(clock.now()).toBe(local + 90_000);
    expect(changes).toBe(1);
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([
      CLOCK_INTERVAL_MS,
    ]);
    timers.fire();
    await flush();
    expect(clock.offset).toBe(90_000); // a failure keeps the value
    timers.fire();
    await flush();
    expect(clock.offset).toBe(-5000);
    expect(changes).toBe(2);
    clock.stop();
    expect(timers.pending.size).toBe(0);
  });

  it("ignores an answer that arrives after stopping", async () => {
    let resolve: (value: { now_ms: number }) => void = () => undefined;
    const clock = new TotpClock({
      time: () => new Promise((r) => (resolve = r)),
      timers: fakeTimers().timers,
      now: () => 0,
    });
    clock.start();
    clock.stop();
    resolve({ now_ms: 60_000 });
    await flush();
    expect(clock.offset).toBe(0);
  });

  it("uses the local clock and no listener by default", async () => {
    const clock = new TotpClock({
      time: () => Promise.resolve({ now_ms: Date.now() + 60_000 }),
      timers: fakeTimers().timers,
    });
    clock.start();
    await flush();
    expect(Math.abs(clock.offset - 60_000)).toBeLessThan(1000);
    clock.stop();
  });
});

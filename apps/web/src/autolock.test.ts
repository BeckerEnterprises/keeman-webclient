import { describe, expect, it } from "vitest";
import { lockReason } from "./autolock";

const settings = { autoLockMinutes: 15, lockOnHiddenMinutes: null };
const minute = 60_000;

describe("auto-lock decision", () => {
  it("locks after inactivity", () => {
    const state = {
      lastActivity: 0,
      lastTick: 15 * minute - 10_000,
      hiddenSince: undefined,
    };
    expect(lockReason(state, 15 * minute - 1, false, settings)).toBeUndefined();
    expect(lockReason(state, 15 * minute, false, settings)).toBe("inactive");
  });

  it("treats long gaps between ticks as device sleep", () => {
    const state = { lastActivity: 0, lastTick: 0, hiddenSince: undefined };
    expect(lockReason(state, 60_000, false, settings)).toBeUndefined();
    expect(lockReason(state, 60_001, false, settings)).toBe("sleep");
    // Hidden tabs are throttled; only longer gaps count.
    expect(
      lockReason({ ...state, hiddenSince: 0 }, 170_000, true, settings),
    ).toBeUndefined();
    expect(
      lockReason({ ...state, hiddenSince: 0 }, 180_001, true, settings),
    ).toBe("sleep");
  });

  it("locks hidden tabs after the configured time", () => {
    const state = { lastActivity: 0, lastTick: 0, hiddenSince: 0 };
    expect(
      lockReason(state, 1, true, { ...settings, lockOnHiddenMinutes: 0 }),
    ).toBe("hidden");
    expect(lockReason(state, 1, true, settings)).toBeUndefined();
  });
});

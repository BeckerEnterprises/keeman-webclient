import { beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_STORAGE_KEYS,
  kdfMemory,
  loadLocale,
  syncMarks,
  loadTheme,
  saveLocale,
  saveTheme,
  viewState,
  DEFAULT_LAYOUT,
} from "./storage";

const USER = (n: number) =>
  `0192b3a4-5c6d-7e8f-9a0b-${n.toString(16).padStart(12, "0")}`;

describe("browser storage", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("writes only the allowed keys", async () => {
    saveTheme("dark");
    saveLocale("en");
    kdfMemory.set(USER(1), { ops: 3, mem: 67108864 });
    await syncMarks.raise(USER(1), {
      ud: [1, 1],
      vaults: { [USER(2)]: { rev: 3, obj: { [USER(3)]: -2 } } },
    });
    viewState.saveTree(USER(1), USER(2), { open: [USER(3)], closed: [] });
    expect(Object.keys(localStorage).sort()).toEqual(
      [...ALLOWED_STORAGE_KEYS].sort(),
    );
    saveTheme("system");
    expect(Object.keys(localStorage)).not.toContain("keeman.theme");
  });

  it("drops invalid values", () => {
    localStorage.setItem("keeman.theme", "purple");
    localStorage.setItem("keeman.locale", "fr");
    localStorage.setItem("keeman.kdfSeen", '{"v":2,"users":{}}');
    expect(loadTheme()).toBe("system");
    expect(loadLocale()).toBeUndefined();
    expect(kdfMemory.get(USER(1))).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it("ignores keys that could pollute prototypes", () => {
    localStorage.setItem(
      "keeman.kdfSeen",
      '{"v":1,"users":{"__proto__":{"ops":1,"mem":1}}}',
    );
    expect(kdfMemory.get("__proto__")).toBeUndefined();
    expect(({} as Record<string, unknown>).ops).toBeUndefined();
  });

  it("keeps the 20 most recently used accounts", () => {
    for (let i = 0; i < 25; i++)
      kdfMemory.set(USER(i), { ops: 3, mem: 67108864 });
    kdfMemory.set(USER(7), { ops: 4, mem: 134217728 });
    const stored = JSON.parse(
      localStorage.getItem("keeman.kdfSeen") ?? "{}",
    ) as {
      users: Record<string, unknown>;
    };
    expect(Object.keys(stored.users)).toHaveLength(20);
    expect(Object.keys(stored.users).at(-1)).toBe(USER(7));
    expect(kdfMemory.get(USER(0))).toBeUndefined();
    expect(kdfMemory.get(USER(7))).toEqual({ ops: 4, mem: 134217728 });
  });
});

describe("rollback marks", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores IDs and counters only and forgets accounts", async () => {
    await syncMarks.raise(USER(1), {
      vaults: { [USER(2)]: { rev: 3, obj: { [USER(3)]: 2 } } },
    });
    expect(JSON.parse(localStorage.getItem("keeman.syncSeen") ?? "")).toEqual({
      v: 1,
      users: {
        [USER(1)]: { vaults: { [USER(2)]: { rev: 3, obj: { [USER(3)]: 2 } } } },
      },
    });
    await syncMarks.forgetUser(USER(1));
    expect(JSON.parse(localStorage.getItem("keeman.syncSeen") ?? "")).toEqual({
      v: 1,
      users: {},
    });
    kdfMemory.set(USER(1), { ops: 3, mem: 67108864 });
    kdfMemory.forget(USER(1));
    kdfMemory.forget(USER(9));
    expect(kdfMemory.get(USER(1))).toBeUndefined();
  });

  it("drops invalid stored marks", async () => {
    localStorage.setItem("keeman.syncSeen", '{"v":1,"users":{"x":1}}');
    expect(await syncMarks.read(USER(1))).toEqual({ vaults: {} });
    expect(localStorage.getItem("keeman.syncSeen")).toBeNull();
  });

  it("keeps view layout and tree deviations within limits (keeman.view)", () => {
    expect(viewState.layout()).toEqual(DEFAULT_LAYOUT);
    viewState.saveLayout({
      ...DEFAULT_LAYOUT,
      detail: "bottom",
      subgroups: true,
    });
    expect(viewState.layout()).toMatchObject({
      detail: "bottom",
      subgroups: true,
    });
    viewState.saveTree(USER(1), USER(2), {
      open: [USER(3)],
      closed: [USER(4)],
    });
    expect(viewState.tree(USER(1), USER(2))).toEqual({
      open: [USER(3)],
      closed: [USER(4)],
    });
    expect(viewState.tree(USER(1), USER(9))).toEqual({ open: [], closed: [] });
    // At most 20 accounts, the most recently used kept.
    for (let i = 10; i < 40; i++)
      viewState.saveTree(USER(i), USER(2), { open: [USER(3)], closed: [] });
    expect(viewState.tree(USER(1), USER(2)).open).toEqual([]);
    expect(viewState.tree(USER(39), USER(2)).open).toEqual([USER(3)]);
    // At most 2000 IDs per vault.
    const many = Array.from({ length: 2500 }, (_, i) => USER(100 + i));
    viewState.saveTree(USER(39), USER(2), { open: many, closed: [] });
    expect(viewState.tree(USER(39), USER(2)).open).toHaveLength(2000);
    viewState.forget(USER(39));
    expect(viewState.tree(USER(39), USER(2)).open).toEqual([]);
    // Invalid content is dropped.
    localStorage.setItem("keeman.view", '{"v":1,"users":{"x":{}}}');
    expect(viewState.layout()).toEqual(DEFAULT_LAYOUT);
    expect(localStorage.getItem("keeman.view")).toBeNull();
    expect(JSON.stringify(localStorage).length).toBeLessThan(600_000);
  });
});

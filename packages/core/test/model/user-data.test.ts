import { describe, expect, it } from "vitest";
import {
  applyUserDataChange,
  contactsOf,
  effectiveSettings,
  initialUserData,
  inspectUserData,
  isRecoveryKeyConfirmed,
  mergeUserData,
  SETTING_DEFAULTS,
  vaultOrderOf,
} from "../../src/model/user-data";

const ALICE = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b";
const BOB = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6c";
const FP_A = "A".repeat(64);
const FP_B = "B".repeat(64);

function contact(userId: string, fingerprint: string) {
  return {
    userId,
    email: "x@example.com",
    fingerprint,
    verifiedAt: "2026-10-23T08:42:00.000Z",
  };
}

describe("user_data defaults and validation", () => {
  it("writes the initial content of a new account", () => {
    expect(initialUserData("en")).toEqual({
      schema: 1,
      seq: 1,
      contacts: [],
      settings: { language: "en" },
      recoveryKeyConfirmed: false,
    });
  });

  it("uses defaults for missing and out-of-range settings", () => {
    expect(effectiveSettings({ schema: 1, seq: 1 })).toEqual(SETTING_DEFAULTS);
    expect(
      effectiveSettings({
        schema: 1,
        seq: 1,
        settings: {
          language: "fr",
          autoLockMinutes: 0,
          lockOnHiddenMinutes: 1441,
          clipboardClearSeconds: 4,
        },
      }),
    ).toEqual(SETTING_DEFAULTS);
    expect(
      effectiveSettings({
        schema: 1,
        seq: 1,
        settings: {
          language: "de",
          autoLockMinutes: 1440,
          lockOnHiddenMinutes: 0,
          clipboardClearSeconds: null,
        },
      }),
    ).toEqual({
      ...SETTING_DEFAULTS,
      language: "de",
      autoLockMinutes: 1440,
      lockOnHiddenMinutes: 0,
      clipboardClearSeconds: null,
    });
  });

  it("reads search and generator settings, the generator per field", () => {
    const settings = effectiveSettings({
      schema: 1,
      seq: 1,
      settings: {
        searchProtectedFields: true,
        passwordGenerator: { mode: "words", words: 2, separator: "." },
      },
    });
    expect(settings.searchProtectedFields).toBe(true);
    expect(settings.passwordGenerator).toEqual({
      ...SETTING_DEFAULTS.passwordGenerator,
      mode: "words",
      separator: ".",
    });
    const raw = initialUserData("de");
    const next = applyUserDataChange(raw, {
      settings: {
        searchProtectedFields: false,
        passwordGenerator: {
          ...SETTING_DEFAULTS.passwordGenerator,
          length: 32,
        },
      },
    });
    expect(effectiveSettings(next).passwordGenerator.length).toBe(32);
    expect(() =>
      applyUserDataChange(raw, {
        settings: {
          passwordGenerator: {
            ...SETTING_DEFAULTS.passwordGenerator,
            length: 2,
          },
        },
      }),
    ).toThrow();
  });

  it("reads the TOTP column setting with its default", () => {
    expect(effectiveSettings(initialUserData("de")).showTotpColumn).toBe(true);
    expect(
      effectiveSettings({
        schema: 1,
        seq: 1,
        settings: { showTotpColumn: "no" },
      }).showTotpColumn,
    ).toBe(true);
    const next = applyUserDataChange(initialUserData("de"), {
      settings: { showTotpColumn: false },
    });
    expect(effectiveSettings(next).showTotpColumn).toBe(false);
    expect(() =>
      applyUserDataChange(next, {
        settings: { showTotpColumn: 1 as unknown as boolean },
      }),
    ).toThrow();
  });

  it("checks the list of URL schemes as a whole", () => {
    const read = (allowedUrlSchemes: unknown) =>
      effectiveSettings({ schema: 1, seq: 1, settings: { allowedUrlSchemes } })
        .allowedUrlSchemes;
    expect(effectiveSettings(initialUserData("de")).allowedUrlSchemes).toEqual([
      "http",
      "https",
    ]);
    expect(read(["https", "ssh", "rdp", "x-app+v1.2"])).toEqual([
      "https",
      "ssh",
      "rdp",
      "x-app+v1.2",
    ]);
    expect(read([])).toEqual([]);
    for (const bad of [
      ["https", "SSH"],
      ["https", "https"],
      ["https", "javascript"],
      ["data"],
      ["1ssh"],
      ["ss h"],
      [""],
      [1],
      "https",
      null,
    ])
      expect(read(bad), JSON.stringify(bad)).toEqual(["http", "https"]);
    const next = applyUserDataChange(initialUserData("de"), {
      settings: { allowedUrlSchemes: ["http", "https", "ssh"] },
    });
    expect(effectiveSettings(next).allowedUrlSchemes).toEqual([
      "http",
      "https",
      "ssh",
    ]);
    expect(() =>
      applyUserDataChange(next, {
        settings: { allowedUrlSchemes: ["https", "file"] },
      }),
    ).toThrow();
  });

  it("marks structural errors as corrupt and newer schemas as read-only", () => {
    expect(inspectUserData(undefined)).toEqual({ status: "corrupt" });
    for (const bad of [
      { seq: 1 },
      { schema: 0, seq: 1 },
      { schema: 1, seq: 1.5 },
      { schema: 1, seq: 1, contacts: {} },
      { schema: 1, seq: 1, contacts: [{ userId: "x" }] },
      { schema: 1, seq: 1, settings: [] },
    ]) {
      expect(inspectUserData(bad)).toEqual({ status: "corrupt" });
    }
    const ok = { schema: 1, seq: 3, contacts: [contact(BOB, FP_B)], extra: 1 };
    expect(inspectUserData(ok)).toEqual({
      status: "ok",
      raw: ok,
      readOnly: false,
    });
    expect(inspectUserData({ schema: 2, seq: 1 })).toMatchObject({
      readOnly: true,
    });
  });

  it("treats a missing recovery key flag as confirmed", () => {
    expect(isRecoveryKeyConfirmed({ schema: 1, seq: 1 })).toBe(true);
    expect(isRecoveryKeyConfirmed(initialUserData("de"))).toBe(false);
  });
});

describe("applyUserDataChange", () => {
  it("changes only known places of a copy and increases seq", () => {
    const raw = {
      schema: 1,
      seq: 4,
      settings: { language: "de", future: { x: 1 } },
      unknown: [1, 2],
    };
    const next = applyUserDataChange(raw, {
      settings: { autoLockMinutes: 5, language: undefined },
      recoveryKeyConfirmed: true,
    });
    expect(next).toEqual({
      schema: 1,
      seq: 5,
      settings: { future: { x: 1 }, autoLockMinutes: 5 },
      unknown: [1, 2],
      recoveryKeyConfirmed: true,
    });
    expect(raw.seq).toBe(4);
    expect(raw.settings.language).toBe("de");
  });

  it("rejects invalid values and unknown settings", () => {
    const raw = initialUserData("de");
    expect(() =>
      applyUserDataChange(raw, { settings: { autoLockMinutes: 0 } }),
    ).toThrow();
    expect(() =>
      applyUserDataChange(raw, {
        settings: { nope: 1 } as unknown as { autoLockMinutes: number },
      }),
    ).toThrow();
  });
});

describe("mergeUserData", () => {
  it("applies local setting changes to the server copy", () => {
    const base = {
      schema: 1,
      seq: 3,
      settings: { language: "de", autoLockMinutes: 15 },
      recoveryKeyConfirmed: false,
    };
    const local = applyUserDataChange(base, {
      settings: { autoLockMinutes: 5, language: undefined },
      recoveryKeyConfirmed: true,
    });
    const server = {
      schema: 1,
      seq: 6,
      settings: { language: "en", autoLockMinutes: 15, lockOnHiddenMinutes: 2 },
      recoveryKeyConfirmed: false,
      fromNewerClient: true,
    };
    expect(mergeUserData(base, local, server)).toEqual({
      schema: 1,
      seq: 7,
      settings: { autoLockMinutes: 5, lockOnHiddenMinutes: 2 },
      recoveryKeyConfirmed: true,
      fromNewerClient: true,
      contacts: [],
    });
  });

  it("keeps server changes the local side did not touch", () => {
    const base = { schema: 1, seq: 9, settings: { language: "de" } };
    const local = applyUserDataChange(base, {
      settings: { autoLockMinutes: 30 },
    });
    const server = { schema: 1, seq: 4, settings: { language: "en" } };
    expect(mergeUserData(base, local, server)).toMatchObject({
      seq: 10,
      settings: { language: "en", autoLockMinutes: 30 },
    });
  });

  it("merges contacts per contact and flags fingerprint conflicts", () => {
    const base = { schema: 1, seq: 1, contacts: [contact(ALICE, FP_A)] };
    const local = {
      schema: 1,
      seq: 2,
      contacts: [contact(ALICE, FP_A), contact(BOB, FP_B)],
    };
    const server = { schema: 1, seq: 2, contacts: [contact(ALICE, FP_A)] };
    expect(mergeUserData(base, local, server).contacts).toEqual([
      contact(ALICE, FP_A),
      contact(BOB, FP_B),
    ]);
    const conflicting = { schema: 1, seq: 2, contacts: [contact(BOB, FP_A)] };
    expect(mergeUserData(base, local, conflicting).contacts).toEqual([
      { ...contact(BOB, FP_A), conflict: true },
    ]);
    // Both added Bob with the same fingerprint: the server's version wins.
    const updated = { ...contact(BOB, FP_B), email: "new@example.com" };
    expect(
      mergeUserData(
        base,
        { ...local, contacts: [updated] },
        {
          schema: 1,
          seq: 2,
          contacts: [contact(BOB, FP_B)],
        },
      ).contacts,
    ).toEqual([contact(BOB, FP_B)]);
  });

  it("keeps removals and re-verifications of one side", () => {
    const base = {
      schema: 1,
      seq: 1,
      contacts: [
        contact(ALICE, FP_A),
        { ...contact(BOB, FP_A), conflict: true },
      ],
    };
    // Locally Alice was removed and Bob verified again with a new key.
    const local = { schema: 1, seq: 2, contacts: [contact(BOB, FP_B)] };
    const server = { ...base, seq: 2, settings: { autoLockMinutes: 5 } };
    const merged = mergeUserData(base, local, server);
    expect(merged.contacts).toEqual([contact(BOB, FP_B)]);
    expect(merged.settings).toEqual({ autoLockMinutes: 5 });
    // A removal on the server stands when the local side did not touch it.
    const removed = { schema: 1, seq: 2, contacts: [contact(ALICE, FP_A)] };
    expect(mergeUserData(base, base, removed).contacts).toEqual([
      contact(ALICE, FP_A),
    ]);
  });

  it("marks removal against change as a conflict", () => {
    const base = { schema: 1, seq: 1, contacts: [contact(ALICE, FP_A)] };
    const removed = { schema: 1, seq: 2, contacts: [] };
    const changed = {
      schema: 1,
      seq: 2,
      contacts: [{ ...contact(ALICE, FP_B), extra: 1 }],
    };
    expect(mergeUserData(base, removed, changed).contacts).toEqual([
      { ...contact(ALICE, FP_B), extra: 1, conflict: true },
    ]);
    expect(mergeUserData(base, changed, removed).contacts).toEqual([
      { ...contact(ALICE, FP_B), extra: 1, conflict: true },
    ]);
    // Both removed: gone.
    expect(mergeUserData(base, removed, removed).contacts).toEqual([]);
  });

  it("verifies and removes contacts, keeping unknown fields", () => {
    const raw = {
      schema: 1,
      seq: 4,
      contacts: [{ ...contact(ALICE, FP_A), conflict: true, note: "x" }],
    };
    const verified = applyUserDataChange(raw, {
      contacts: [
        {
          kind: "verify",
          userId: ALICE,
          email: "alice@example.com",
          fingerprint: FP_B,
          verifiedAt: "2026-10-25T08:00:00.000Z",
        },
        {
          kind: "verify",
          userId: BOB,
          email: "bob@example.com",
          fingerprint: FP_A,
          verifiedAt: "2026-10-25T08:00:00.000Z",
        },
      ],
    });
    expect(verified.seq).toBe(5);
    expect(contactsOf(verified)).toEqual([
      {
        userId: ALICE,
        email: "alice@example.com",
        fingerprint: FP_B,
        verifiedAt: "2026-10-25T08:00:00.000Z",
        note: "x",
      },
      {
        userId: BOB,
        email: "bob@example.com",
        fingerprint: FP_A,
        verifiedAt: "2026-10-25T08:00:00.000Z",
      },
    ]);
    expect(raw.contacts[0]?.conflict).toBe(true);
    const removed = applyUserDataChange(verified, {
      contacts: [
        { kind: "remove", userId: ALICE },
        { kind: "remove", userId: ALICE },
      ],
    });
    expect(contactsOf(removed).map((c) => c.userId)).toEqual([BOB]);
    expect(() =>
      applyUserDataChange(raw, {
        contacts: [{ kind: "remove", userId: "nope" }],
      }),
    ).toThrow();
    expect(() =>
      applyUserDataChange(raw, {
        contacts: [
          {
            kind: "verify",
            userId: BOB,
            email: "b",
            fingerprint: "abc",
            verifiedAt: "x",
          },
        ],
      }),
    ).toThrow();
    expect(contactsOf({ schema: 1, seq: 1 })).toEqual([]);
  });

  it("never pollutes prototypes with keys from untrusted data", () => {
    const base = { schema: 1, seq: 1, settings: {} };
    const local = JSON.parse(
      '{"schema":1,"seq":2,"settings":{"__proto__":{"polluted":true}}}',
    ) as Record<string, unknown>;
    const merged = mergeUserData(base, local, { schema: 1, seq: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(merged.settings)).toBe(Object.prototype);
    expect(Object.keys(merged.settings as object)).toEqual(["__proto__"]);
  });

  it("removes a recovery key flag the local side removed", () => {
    const base = { schema: 1, seq: 1, recoveryKeyConfirmed: false };
    const local = { schema: 1, seq: 2 };
    const merged = mergeUserData(base, local, {
      schema: 1,
      seq: 1,
      recoveryKeyConfirmed: false,
    });
    expect(merged).not.toHaveProperty("recoveryKeyConfirmed");
  });
});

describe("vaultOrder", () => {
  const A = "0192b3a4-5c6d-7e8f-9a0b-000000000001";
  const B = "0192b3a4-5c6d-7e8f-9a0b-000000000002";
  const C = "0192b3a4-5c6d-7e8f-9a0b-000000000003";

  it("reads only valid IDs and writes the list", () => {
    expect(vaultOrderOf({ schema: 1, seq: 1 })).toEqual([]);
    expect(
      vaultOrderOf({ schema: 1, seq: 1, vaultOrder: [A, 7, "x", B] }),
    ).toEqual([A, B]);
    expect(vaultOrderOf({ schema: 1, seq: 1, vaultOrder: "nope" })).toEqual([]);
    const next = applyUserDataChange(
      { schema: 1, seq: 4 },
      { vaultOrder: [B, A] },
    );
    expect(next.vaultOrder).toEqual([B, A]);
    expect(next.seq).toBe(5);
    expect(() =>
      applyUserDataChange({ schema: 1, seq: 1 }, { vaultOrder: ["x"] }),
    ).toThrow();
  });

  it("keeps a local order as a whole and otherwise the server's", () => {
    const base = { schema: 1, seq: 2, vaultOrder: [A, B] };
    const server = { schema: 1, seq: 3, vaultOrder: [B, A, C] };
    const reordered = applyUserDataChange(base, { vaultOrder: [B, A] });
    expect(mergeUserData(base, reordered, server).vaultOrder).toEqual([B, A]);
    const untouched = applyUserDataChange(base, { recoveryKeyConfirmed: true });
    expect(mergeUserData(base, untouched, server).vaultOrder).toEqual([
      B,
      A,
      C,
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  applyUserDataChange,
  COMPARISON_POINTS_MAX,
  comparisonsOf,
  contactsOf,
  effectiveSettings,
  initialUserData,
  inspectUserData,
  isRecoveryKeyConfirmed,
  mergeUserData,
  roleAnchorOf,
  SETTING_DEFAULTS,
  vaultOrderOf,
  type ComparisonChange,
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
          fingerprint2: FP_A,
          verifiedAt: "2026-10-25T08:00:00.000Z",
        },
        {
          kind: "verify",
          userId: BOB,
          email: "bob@example.com",
          fingerprint: FP_A,
          fingerprint2: FP_B,
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
        fingerprint2: FP_A,
        verifiedAt: "2026-10-25T08:00:00.000Z",
        note: "x",
      },
      {
        userId: BOB,
        email: "bob@example.com",
        fingerprint: FP_A,
        fingerprint2: FP_B,
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
            fingerprint2: FP_A,
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

describe("roles anchors", () => {
  const VAULT = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5b01";
  const OTHER = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5b02";
  const H1 = "A".repeat(43);
  const H2 = "Q".repeat(42) + "A";
  const base = { schema: 1, seq: 1 };

  it("writes, reads and removes anchors; invalid entries count as missing", () => {
    const raw = applyUserDataChange(base, {
      roles: { [VAULT]: { version: 2, hash: H1, owners: [ALICE] } },
    });
    expect(roleAnchorOf(raw, VAULT)).toEqual({
      version: 2,
      hash: H1,
      owners: [ALICE],
    });
    expect(roleAnchorOf(raw, OTHER)).toBeUndefined();
    const removed = applyUserDataChange(raw, { roles: { [VAULT]: null } });
    expect(roleAnchorOf(removed, VAULT)).toBeUndefined();
    for (const entry of [
      [0, H1, []],
      [1, "short", []],
      [1, H1, ["nope"]],
      [1, H1],
      "x",
    ])
      expect(
        roleAnchorOf({ ...base, roles: { [VAULT]: entry } }, VAULT),
      ).toBeUndefined();
    expect(roleAnchorOf({ ...base, roles: [] }, VAULT)).toBeUndefined();
    expect(() =>
      applyUserDataChange(base, {
        roles: { nope: { version: 1, hash: H1, owners: [] } },
      }),
    ).toThrow();
    expect(() =>
      applyUserDataChange(base, {
        roles: { [VAULT]: { version: 0, hash: H1, owners: [] } },
      }),
    ).toThrow();
  });

  it("merges per vault: the higher version wins, the server's at a tie", () => {
    const at = (version: number, hash: string) => ({
      [VAULT]: { version, hash, owners: [ALICE] },
    });
    const start = applyUserDataChange(base, { roles: at(1, H1) });
    const local = applyUserDataChange(start, { roles: at(3, H1) });
    const lower = applyUserDataChange(start, { roles: at(2, H2) });
    expect(
      roleAnchorOf(mergeUserData(start, local, lower), VAULT),
    ).toMatchObject({ version: 3 });
    const higher = applyUserDataChange(start, { roles: at(4, H2) });
    expect(
      roleAnchorOf(mergeUserData(start, local, higher), VAULT),
    ).toMatchObject({ version: 4 });
    const tie = applyUserDataChange(start, { roles: at(3, H2) });
    expect(roleAnchorOf(mergeUserData(start, local, tie), VAULT)).toMatchObject(
      {
        version: 3,
        hash: H2,
      },
    );
    // Unchanged locally: the server's stays, also without roles locally.
    expect(
      roleAnchorOf(mergeUserData(start, start, higher), VAULT),
    ).toMatchObject({ version: 4 });
    expect(mergeUserData(base, base, base).roles).toBeUndefined();
  });

  it("keeps a local removal unless the server changed the anchor", () => {
    const at = (version: number, hash: string) => ({
      [VAULT]: { version, hash, owners: [ALICE] },
    });
    const start = applyUserDataChange(base, { roles: at(1, H1) });
    const removed = applyUserDataChange(start, { roles: { [VAULT]: null } });
    const other = applyUserDataChange(start, { recoveryKeyConfirmed: true });
    expect(
      roleAnchorOf(mergeUserData(start, removed, other), VAULT),
    ).toBeUndefined();
    // The server raised it meanwhile: its anchor stays.
    const raised = applyUserDataChange(start, { roles: at(2, H2) });
    expect(
      roleAnchorOf(mergeUserData(start, removed, raised), VAULT),
    ).toMatchObject({ version: 2 });
  });

  it("merges contacts by fingerprint version 2 where both have it", () => {
    const contact = (fingerprint2: string) => ({
      userId: BOB,
      email: "bob@example.com",
      fingerprint: FP_A,
      fingerprint2,
      verifiedAt: "2026-10-25T08:00:00.000Z",
    });
    const start = { ...base, contacts: [contact(FP_A)] };
    const mine = { ...base, contacts: [{ ...contact(FP_B), verifiedAt: "x" }] };
    const theirs = {
      ...base,
      contacts: [{ ...contact(FP_B), verifiedAt: "y" }],
    };
    expect(contactsOf(mergeUserData(start, mine, theirs))[0]?.conflict).toBe(
      undefined,
    );
    const other = {
      ...base,
      contacts: [{ ...contact(FP_A), verifiedAt: "y" }],
    };
    expect(contactsOf(mergeUserData(start, mine, other))[0]?.conflict).toBe(
      true,
    );
  });
});

describe("comparisons", () => {
  const VAULT = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5b01";
  const A = "K3QF6XMA2PLRTB6WQH4N7ZDEXA";
  const B = "LTI7RYKS2VIW4CMGXO2UE2YJZA";
  const AT = "2026-10-28T09:00:00.000Z";
  const LATER = "2026-10-28T10:00:00.000Z";
  const base = { schema: 1, seq: 1 };
  const point = (version: number, code: string, at = AT) => ({
    version,
    code,
    at,
  });

  it("adds each point once, removes by version and code, keeps a match", () => {
    const one = applyUserDataChange(base, {
      compared: {
        [VAULT]: {
          add: [point(3, A), point(3, A), point(4, B)],
          match: { version: 2, at: AT, partner: ALICE },
        },
      },
    });
    expect(comparisonsOf(one, VAULT)).toEqual({
      points: [point(3, A), point(4, B)],
      match: { version: 2, at: AT, partner: ALICE },
    });
    const two = applyUserDataChange(one, {
      compared: { [VAULT]: { remove: [{ version: 3, code: A }] } },
    });
    expect(comparisonsOf(two, VAULT).points).toEqual([point(4, B)]);
    expect(comparisonsOf(two, VAULT).match?.version).toBe(2);
    expect(comparisonsOf(base, VAULT)).toEqual({
      points: [],
      match: undefined,
    });
  });

  it("skips invalid elements, keeps them and unknown fields when writing", () => {
    const raw = {
      ...base,
      compared: {
        [VAULT]: {
          points: [
            [3, A, AT],
            [0, A, AT],
            [3, "a".repeat(26), AT],
            [3, `${A.slice(0, -1)}B`, AT],
            [3, A, "yesterday"],
            "x",
          ],
          match: [1, AT, "nope"],
          note: "kept",
        },
      },
    };
    expect(comparisonsOf(raw, VAULT)).toEqual({
      points: [point(3, A)],
      match: undefined,
    });
    const next = applyUserDataChange(raw, {
      compared: { [VAULT]: { add: [point(4, B)] } },
    });
    const entry = (next.compared as Record<string, Record<string, unknown>>)[
      VAULT
    ];
    expect(entry?.note).toBe("kept");
    expect((entry?.points as unknown[]).length).toBe(7);
    expect(
      comparisonsOf({ ...base, compared: { [VAULT]: [] } }, VAULT).points,
    ).toEqual([]);
  });

  it("refuses invalid points, vaults and too many points", () => {
    const changes: Record<string, ComparisonChange>[] = [
      { [VAULT]: { add: [point(0, A)] } },
      { [VAULT]: { add: [point(1, "A".repeat(26).slice(1))] } },
      { [VAULT]: { match: { version: 1, at: AT, partner: "x" } } },
      { nope: { add: [point(1, A)] } },
    ];
    for (const change of changes)
      expect(() => applyUserDataChange(base, { compared: change })).toThrow();
    const many = Array.from({ length: COMPARISON_POINTS_MAX + 1 }, (_, i) =>
      point(i + 1, A),
    );
    expect(() =>
      applyUserDataChange(base, { compared: { [VAULT]: { add: many } } }),
    ).toThrow();
  });

  it("merges points as a set and keeps a point added elsewhere", () => {
    const start = applyUserDataChange(base, {
      compared: { [VAULT]: { add: [point(3, A)] } },
    });
    // This device understood the warning; another one added a point.
    const local = applyUserDataChange(start, {
      compared: { [VAULT]: { remove: [{ version: 3, code: A }] } },
    });
    const server = applyUserDataChange(start, {
      compared: { [VAULT]: { add: [point(5, B, LATER)] } },
    });
    expect(
      comparisonsOf(mergeUserData(start, local, server), VAULT).points,
    ).toEqual([point(5, B, LATER)]);
    // A point added on both sides counts once, with the server's time.
    const mine = applyUserDataChange(start, {
      compared: { [VAULT]: { add: [point(5, B)] } },
    });
    expect(
      comparisonsOf(mergeUserData(start, mine, server), VAULT).points,
    ).toEqual([point(3, A), point(5, B, LATER)]);
    // The later match wins.
    const early = applyUserDataChange(start, {
      compared: { [VAULT]: { match: { version: 3, at: AT, partner: null } } },
    });
    const late = applyUserDataChange(start, {
      compared: {
        [VAULT]: { match: { version: 4, at: LATER, partner: null } },
      },
    });
    expect(
      comparisonsOf(mergeUserData(start, early, late), VAULT).match?.version,
    ).toBe(4);
    expect(
      comparisonsOf(mergeUserData(start, late, early), VAULT).match?.version,
    ).toBe(4);
    expect(mergeUserData(base, base, base).compared).toBeUndefined();
  });
});

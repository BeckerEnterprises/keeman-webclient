import { describe, expect, it } from "vitest";
import type { VaultSummary } from "../../src/api/schemas";
import type { ObjectType } from "../../src/crypto/aad";
import { VaultState, type ObjectEntry } from "../../src/sync/vault";
import { toBase64Url } from "../../src/crypto/bytes";
import { iconDataUrl, iconHash } from "../../src/model/icon";
import { VaultProjection } from "../../src/sync/views";
import { fingerprint2Hex, fingerprintHex } from "../../src/crypto/fingerprint";
import { roleOwner } from "../../src/crypto/roles";
import { iconPng, tv } from "../helpers";

const VAULT = "0192b3a4-5c6d-7e8f-9a0b-000000000001";
const ROOT = "0192b3a4-5c6d-7e8f-9a0b-000000000002";
const BIN = "0192b3a4-5c6d-7e8f-9a0b-000000000003";
const G = "0192b3a4-5c6d-7e8f-9a0b-000000000004";
const E = "0192b3a4-5c6d-7e8f-9a0b-000000000005";
const F = "0192b3a4-5c6d-7e8f-9a0b-000000000006";
const KEY = "A".repeat(43);
const collator = new Intl.Collator("de", { numeric: true });

function object(
  id: string,
  type: ObjectType,
  raw: Record<string, unknown>,
  revision = 1,
): ObjectEntry {
  return {
    id,
    type,
    revision,
    keyVersion: 1,
    raw: { schema: 1, seq: 1, ...raw },
    seq: 1,
    readOnly: false,
    rollback: false,
    invalid: false,
  };
}

function state(): VaultState {
  const summary = {
    vault_id: VAULT,
    role: "owner",
    state: "active",
    revision: 1,
    vault_key_version: 1,
    member_key_version: 1,
    member_count: 1,
    created: "2026-10-23T08:00:00.000Z",
  } as unknown as VaultSummary;
  const s = new VaultState(summary);
  s.synced = true;
  s.freshness = { status: "fresh", since: 0 };
  const objects: ObjectEntry[] = [
    object(VAULT, "vault_meta", {
      name: "V",
      rootGroupId: ROOT,
      recycleBinGroupId: BIN,
      icon: { type: "builtin", name: "users" },
    }),
    object(ROOT, "group", { name: "Root", parentId: null }),
    object(BIN, "group", { name: "Bin", parentId: ROOT, sortKey: "a0" }),
    object(G, "group", {
      name: "G",
      parentId: ROOT,
      sortKey: "a1",
      defaultEntryIcon: { type: "builtin", name: "server" },
    }),
    object(E, "entry", {
      parentId: G,
      title: "Mail",
      username: "u",
      password: "geheim",
      notes: "notiz",
      otp: "otpauth://totp/x?secret=ABC",
      fields: [{ id: F, name: "PIN", value: "1234", protected: true }],
      history: [
        { schema: 1, title: "Mail", password: "alt" },
        { schema: 1, title: "Alt", password: "alt" },
      ],
    }),
  ];
  for (const o of objects) s.objects.set(o.id, o);
  return s;
}

describe("owners of a roles warning", () => {
  it("names a contact only when it is verified with the keys of the chain", () => {
    const s = state();
    const bob = "0192b3a4-5c6d-7e8f-9a0b-000000000010";
    const carol = "0192b3a4-5c6d-7e8f-9a0b-000000000011";
    const key = (label: string) => tv(`views-owner-${label}`, 32);
    // The delivered head names Bob with his keys and Carol with keys the
    // server made up; both are verified contacts.
    s.roles = {
      version: 2,
      status: "fork",
      statements: [],
      head: undefined,
      anchor: undefined,
      deliveredOwners: [
        roleOwner(bob, key("bob"), key("bob-sign")),
        roleOwner(carol, key("forged"), key("forged-sign")),
      ],
      deliveredHead: undefined,
      verifyOwners: false,
    };
    const contact = (userId: string, email: string, label: string) => ({
      userId,
      email,
      fingerprint: fingerprintHex(key(label)),
      fingerprint2: fingerprint2Hex(key(label), key(`${label}-sign`)),
      verifiedAt: "2026-10-23T08:00:00.000Z",
    });
    s.members = [
      {
        user_id: carol,
        email: "carol@server.example",
        role: "owner",
        state: "active",
        public_key: toBase64Url(key("carol")),
        signing_public_key: toBase64Url(key("carol-sign")),
      } as never,
    ];
    const view = new VaultProjection(VAULT).view(s, collator, [
      contact(bob, "bob@example.org", "bob"),
      contact(carol, "carol@example.org", "carol"),
    ]);
    expect(view.roles.owners).toEqual([
      {
        userId: bob,
        email: "bob@example.org",
        verified: true,
        keysDiffer: false,
      },
      {
        userId: carol,
        email: "carol@server.example",
        verified: false,
        keysDiffer: true,
      },
    ]);
    // An address of the server that would read as two names or as someone
    // else's is not shown at all.
    for (const email of [
      "alice@example.org, bob@example.org",
      "eve@example.org\u202Egro.elpmaxe@ecila",
      "eve example@example.org",
    ]) {
      s.members = [{ ...(s.members[0] as object), email } as never];
      const other = new VaultProjection(VAULT).view(s, collator, []);
      expect(other.roles.owners[1]?.email).toBeUndefined();
    }
  });
});

describe("projection", () => {
  it("has summaries without secrets and details on request", () => {
    const s = state();
    const projection = new VaultProjection(VAULT);
    const view = projection.view(s, collator);
    expect(view).toMatchObject({
      name: "V",
      icon: "users",
      writable: true,
      status: "ready",
    });
    const summary = view.entries.get(E);
    expect(summary).toMatchObject({
      title: "Mail",
      username: "u",
      icon: "server",
      hasPassword: true,
      totp: "unsupported",
      historyCount: 2,
      groupId: G,
    });
    const text = JSON.stringify(summary);
    for (const secret of ["geheim", "notiz", "1234", "otpauth", "alt"])
      expect(text).not.toContain(secret);
    const detail = projection.detail(s, E, collator);
    expect(detail?.values).toMatchObject({
      password: "geheim",
      notes: "notiz",
      icon: "server",
    });
    expect(detail?.values.fields[0]).toMatchObject({
      name: "PIN",
      value: "1234",
      protected: true,
    });
    expect(detail?.path).toEqual([ROOT, G]);
    expect(detail?.history.map((h) => h.changed)).toEqual([
      ["fields", "notes", "otp", "password", "username"],
      ["title"],
    ]);
    // Details carry the secrets of the chosen entry, the TOTP URI too.
    expect(detail?.values.otp).toBe("otpauth://totp/x?secret=ABC");
    expect(detail?.history[0]?.values.otp).toBeNull();
    expect(projection.detail(s, "nope", collator)).toBeUndefined();
  });

  it("resolves references in lists and details", () => {
    const s = state();
    const R = "0192b3a4-5c6d-7e8f-9a0b-000000000008";
    const ref = (field: string) =>
      `{REF:${field}@I:${E.replaceAll("-", "").toUpperCase()}}`;
    s.objects.set(
      R,
      object(R, "entry", {
        parentId: ROOT,
        title: ref("T"),
        username: `${ref("U")}2`,
        password: ref("P"),
        notes: ref("N"),
        url: `https://h/${ref("U")}?p={PASSWORD}&n=${ref("N")}`,
        fields: [{ id: F, name: "Pin", value: ref("P"), protected: false }],
      }),
    );
    const projection = new VaultProjection(VAULT);
    const summary = projection.view(s, collator).entries.get(R);
    expect(summary).toMatchObject({
      title: "Mail",
      username: "u2",
      url: `https://h/u?p={PASSWORD}&n=${ref("N")}`,
    });
    for (const secret of ["geheim", "notiz"])
      expect(JSON.stringify(summary)).not.toContain(secret);

    const detail = projection.detail(s, R, collator);
    expect(detail?.values.title).toBe(ref("T"));
    expect(detail?.resolved.title).toMatchObject({ value: "Mail", refs: true });
    expect(detail?.resolved.password).toMatchObject({
      value: "geheim",
      secret: true,
    });
    expect(detail?.resolved.notes.value).toBe("notiz");
    expect(detail?.resolved.fields[0]).toMatchObject({
      value: "geheim",
      secret: true,
      refs: true,
    });
    expect(detail?.resolved.url).toEqual({
      ok: true,
      url: "https://h/u?p=geheim&n=notiz",
      display: "https://h/u?p=••••••&n=notiz",
      secret: true,
      warnings: [],
    });
    expect(projection.detail(s, E, collator)?.resolved.url).toBeUndefined();

    const target = s.objects.get(E);
    if (target)
      s.objects.set(E, object(E, "entry", { ...target.raw, username: "neu" }));
    expect(projection.view(s, collator).entries.get(R)?.username).toBe("neu2");
  });

  it("keeps the identity of unchanged objects and vaults", () => {
    const s = state();
    const projection = new VaultProjection(VAULT);
    const first = projection.view(s, collator);
    expect(projection.view(s, collator)).toBe(first);
    const other = "0192b3a4-5c6d-7e8f-9a0b-000000000007";
    s.objects.set(
      other,
      object(other, "entry", { parentId: ROOT, title: "Neu" }),
    );
    const second = projection.view(s, collator);
    expect(second).not.toBe(first);
    expect(second.entries.get(E)).toBe(first.entries.get(E));
    expect(second.tree.nodes.get(G)).toBe(first.tree.nodes.get(G));
    expect(second.tree.nodes.get(ROOT)).not.toBe(first.tree.nodes.get(ROOT));
    const entry = s.objects.get(E);
    if (entry) entry.rollback = true;
    const third = projection.view(s, collator);
    expect(third.entries.get(E)).not.toBe(second.entries.get(E));
    expect(third.entries.get(E)).toMatchObject({
      rollback: true,
      writable: false,
    });
    expect(third.rollback).toBe(true);
  });

  it("keeps file keys out of entry details", () => {
    const s = state();
    const projection = new VaultProjection(VAULT);
    const a = "0192b3a4-5c6d-7e8f-9a0b-000000000008";
    const c = "0192b3a4-5c6d-7e8f-9a0b-00000000000a";
    s.objects.set(
      a,
      object(a, "entry", {
        parentId: G,
        attachments: [
          {
            id: F,
            name: "x",
            mime: "x",
            size: 1,
            key: KEY,
            compression: "none",
          },
        ],
      }),
    );
    s.objects.set(
      c,
      object(c, "entry", {
        parentId: G,
        history: [{ schema: 1, attachments: [{}] }],
      }),
    );
    const view = projection.view(s, collator);
    expect(view.entries.get(c)).toMatchObject({
      readOnly: "invalid",
      invalid: 1,
    });
    const detail = projection.detail(s, a, collator);
    expect(detail?.values.attachments).toEqual([
      { id: F, name: "x", mime: "x", size: 1, compression: "none" },
    ]);
    expect(JSON.stringify(detail)).not.toContain(KEY);
  });

  it("shows corrupt meta, a newer schema and loading states", () => {
    const s = state();
    s.objects.delete(VAULT);
    s.synced = false;
    const projection = new VaultProjection(VAULT);
    const view = projection.view(s, collator);
    expect(view).toMatchObject({
      name: undefined,
      status: "loading",
      writable: false,
    });
    expect(view.tree.rootId).toBe(VAULT);
    expect(view.tree.missingRoot).toBe(true);
    const newer = state();
    const entry = newer.objects.get(E);
    if (entry) entry.readOnly = true;
    newer.keyOk = false;
    const other = new VaultProjection(VAULT).view(newer, collator);
    expect(other.status).toBe("corrupt");
    expect(other.entries.get(E)?.readOnly).toBe("schema");
    newer.keyOk = true;
    newer.error = new Error("x");
    expect(new VaultProjection(VAULT).view(newer, collator).status).toBe(
      "error",
    );
  });
});

describe("custom icons", () => {
  const I1 = "0192b3a4-5c6d-7e8f-9a0b-0000000000a1";
  const I2 = "0192b3a4-5c6d-7e8f-9a0b-0000000000a2";
  const BAD = "0192b3a4-5c6d-7e8f-9a0b-0000000000a3";
  const GONE = "0192b3a4-5c6d-7e8f-9a0b-0000000000a4";
  const E2 = "0192b3a4-5c6d-7e8f-9a0b-0000000000b1";
  const custom = (id: string) => ({ type: "custom", id });

  function withIcons(): VaultState {
    const s = state();
    s.objects.set(
      I1,
      object(I1, "icon", {
        name: "Nordhost",
        mime: "image/png",
        data: toBase64Url(iconPng(1)),
        source: { type: "favicon", origin: "https://www.example.net" },
      }),
    );
    s.objects.set(
      I2,
      object(I2, "icon", { mime: "image/png", data: toBase64Url(iconPng(2)) }),
    );
    // Not a 64 × 64 PNG: like a corrupt icon, references show the default.
    s.objects.set(
      BAD,
      object(BAD, "icon", {
        mime: "image/png",
        data: toBase64Url(iconPng(3, 32, 32)),
      }),
    );
    const meta = s.objects.get(VAULT);
    if (meta)
      s.objects.set(
        VAULT,
        object(VAULT, "vault_meta", { ...meta.raw, icon: custom(I2) }),
      );
    s.objects.set(
      G,
      object(G, "group", {
        name: "G",
        parentId: ROOT,
        sortKey: "a1",
        icon: custom(BAD),
        defaultEntryIcon: custom(I1),
      }),
    );
    s.objects.set(
      E2,
      object(E2, "entry", {
        parentId: G,
        title: "Gone",
        icon: custom(GONE),
        history: [
          { schema: 1, icon: custom(I1) },
          { schema: 1, icon: null },
        ],
      }),
    );
    return s;
  }

  it("lists valid icons with their data URL and usage", () => {
    const view = new VaultProjection(VAULT).view(withIcons(), collator);
    expect([...view.icons.keys()].sort()).toEqual([I1, I2]);
    expect(view.icons.get(I1)).toEqual({
      id: I1,
      name: "Nordhost",
      src: iconDataUrl(toBase64Url(iconPng(1))),
      hash: iconHash(iconPng(1)),
      source: { type: "favicon", origin: "https://www.example.net" },
      used: true,
      writable: true,
    });
    expect(view.icons.get(I2)).toMatchObject({
      name: "",
      source: null,
      used: true,
    });
    expect(view.iconCleanup).toBe("ok");
  });

  it("resolves references, inherited ones included", () => {
    const s = withIcons();
    const projection = new VaultProjection(VAULT);
    const view = projection.view(s, collator);
    expect(view).toMatchObject({ icon: "database", customIcon: I2 });
    expect(view.tree.nodes.get(ROOT)).toMatchObject({ customIcon: I2 });
    // The group's own icon is not a valid icon: the default shows.
    expect(view.tree.nodes.get(G)).toMatchObject({
      icon: "folder",
      customIcon: undefined,
      iconRef: custom(BAD),
      defaultEntryIcon: custom(I1),
    });
    // E has no own icon and inherits the group's default entry icon.
    expect(view.entries.get(E)).toMatchObject({
      icon: "key-round",
      customIcon: I1,
    });
    expect(view.entries.get(E2)).toMatchObject({
      icon: "key-round",
      customIcon: undefined,
    });
    const detail = projection.detail(s, E2, collator);
    expect(detail?.values.customIcon).toBeUndefined();
    expect(detail?.history.map((h) => h.values.customIcon)).toEqual([
      I1,
      undefined,
    ]);
    expect(projection.detail(s, E, collator)?.values.customIcon).toBe(I1);
  });

  it("counts snapshots and marks unused icons", () => {
    const s = withIcons();
    s.objects.set(
      G,
      object(G, "group", { name: "G", parentId: ROOT, sortKey: "a1" }),
    );
    const meta = s.objects.get(VAULT);
    if (meta)
      s.objects.set(
        VAULT,
        object(VAULT, "vault_meta", {
          ...meta.raw,
          icon: { type: "builtin", name: "users" },
        }),
      );
    const view = new VaultProjection(VAULT).view(s, collator);
    // Only the snapshot of E2 still refers to I1.
    expect(view.icons.get(I1)?.used).toBe(true);
    expect(view.icons.get(I2)?.used).toBe(false);
  });

  it("keeps identities while nothing changes", () => {
    const s = withIcons();
    const projection = new VaultProjection(VAULT);
    const first = projection.view(s, collator);
    const second = projection.view(s, collator);
    expect(second.icons).toBe(first.icons);
    const raw = s.objects.get(I2)?.raw ?? {};
    s.objects.set(I2, object(I2, "icon", { ...raw, name: "Neu" }, 2));
    const third = projection.view(s, collator);
    expect(third.icons).not.toBe(first.icons);
    expect(third.icons.get(I1)).toBe(first.icons.get(I1));
    expect(third.icons.get(I2)).toMatchObject({
      name: "Neu",
      src: first.icons.get(I2)?.src,
    });
    s.objects.delete(I1);
    const fourth = projection.view(s, collator);
    expect(fourth.icons.has(I1)).toBe(false);
    expect(fourth.entries.get(E)?.customIcon).toBeUndefined();
  });

  it("blocks the cleanup for corrupt objects and read-only vaults", () => {
    const s = withIcons();
    s.corrupt.set(GONE, {
      id: GONE,
      type: "icon",
      revision: 1,
      reason: "auth",
    });
    expect(new VaultProjection(VAULT).view(s, collator).iconCleanup).toBe("ok");
    s.corrupt.set(E2, { id: E2, type: "entry", revision: 1, reason: "auth" });
    expect(new VaultProjection(VAULT).view(s, collator).iconCleanup).toBe(
      "corrupt",
    );
    s.rollback = true;
    const view = new VaultProjection(VAULT).view(s, collator);
    expect(view.iconCleanup).toBe("read_only");
    expect(view.icons.get(I1)?.writable).toBe(false);
  });
});

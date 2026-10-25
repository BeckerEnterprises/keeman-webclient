import { describe, expect, it } from "vitest";
import {
  applyObjectChange,
  inspectGroup,
  inspectVaultMeta,
  mergeObject,
  newGroup,
  newVaultMeta,
  normalizeName,
  sameContent,
  timestampOf,
} from "../../src/model/vault";

const VAULT = "0192b3a4-5c6d-7e8f-9a0b-000000000001";
const ROOT = "0192b3a4-5c6d-7e8f-9a0b-000000000002";
const BIN = "0192b3a4-5c6d-7e8f-9a0b-000000000003";
const USER = "0192b3a4-5c6d-7e8f-9a0b-000000000009";
const STAMP = { now: "2026-10-23T08:00:00.000Z", userId: USER };
const LATER = { now: "2026-10-23T09:00:00.000Z", userId: USER };

describe("vault_meta", () => {
  it("reads new content with its defaults", () => {
    const raw = newVaultMeta(
      { name: "Persönlich", rootGroupId: ROOT, recycleBinGroupId: BIN },
      STAMP,
    );
    const inspected = inspectVaultMeta(raw, VAULT, VAULT);
    expect(inspected).toMatchObject({
      status: "ok",
      seq: 1,
      readOnly: false,
      value: {
        name: "Persönlich",
        description: "",
        icon: { type: "builtin", name: "database" },
        color: null,
        rootGroupId: ROOT,
        recycleBinGroupId: BIN,
        recycleBinEnabled: true,
        historyMaxItems: 10,
      },
    });
  });

  it("uses defaults for invalid optional values and keeps them in raw", () => {
    const raw = {
      schema: 1,
      seq: 3,
      name: "X",
      rootGroupId: ROOT,
      recycleBinGroupId: "nope",
      recycleBinEnabled: "yes",
      color: "red",
      historyMaxItems: 101,
      icon: { type: "custom", id: "nope" },
      description: 5,
    };
    const inspected = inspectVaultMeta(raw, VAULT, VAULT);
    expect(inspected.status === "ok" && inspected.value).toEqual({
      name: "X",
      description: "",
      icon: { type: "builtin", name: "database" },
      color: null,
      rootGroupId: ROOT,
      recycleBinGroupId: null,
      recycleBinEnabled: true,
      historyMaxItems: 10,
    });
    expect(inspected.status === "ok" && inspected.raw.color).toBe("red");
    const custom = inspectVaultMeta(
      { ...raw, icon: { type: "custom", id: ROOT }, color: "#2563eb" },
      VAULT,
      VAULT,
    );
    expect(custom.status === "ok" && custom.value.icon).toEqual({
      type: "custom",
      id: ROOT,
    });
    expect(custom.status === "ok" && custom.value.color).toBe("#2563eb");
  });

  it("is corrupt without its required fields or under another ID", () => {
    const good = { schema: 1, seq: 1, name: "X", rootGroupId: ROOT };
    for (const raw of [
      { ...good, name: 5 },
      { ...good, rootGroupId: "x" },
      { ...good, schema: 0 },
      { ...good, seq: 1.5 },
      { schema: 1, seq: 1, rootGroupId: ROOT },
    ]) {
      expect(inspectVaultMeta(raw, VAULT, VAULT).status).toBe("corrupt");
    }
    expect(inspectVaultMeta(good, ROOT, VAULT)).toEqual({
      status: "corrupt",
      reason: "validation",
    });
    expect(
      inspectVaultMeta({ ...good, schema: 2 }, VAULT, VAULT),
    ).toMatchObject({ status: "ok", readOnly: true });
  });
});

describe("group", () => {
  it("reads groups and requires name and parentId", () => {
    const raw = newGroup({ name: "Server", parentId: ROOT }, STAMP);
    expect(inspectGroup(raw)).toMatchObject({
      status: "ok",
      value: {
        name: "Server",
        parentId: ROOT,
        sortKey: "",
        icon: { type: "builtin", name: "folder" },
        defaultEntryIcon: null,
        notes: "",
        previousParentId: undefined,
      },
    });
    expect(
      inspectGroup(newGroup({ name: "Root", parentId: null }, STAMP)),
    ).toMatchObject({ status: "ok", value: { parentId: null } });
    const bin = newGroup(
      {
        name: "Bin",
        parentId: ROOT,
        icon: { type: "builtin", name: "trash-2" },
      },
      STAMP,
    );
    expect(inspectGroup(bin)).toMatchObject({
      value: { icon: { type: "builtin", name: "trash-2" } },
    });
    for (const broken of [
      { schema: 1, seq: 1, name: "X" },
      { schema: 1, seq: 1, name: "X", parentId: "nope" },
      { schema: 1, seq: 1, parentId: ROOT },
    ]) {
      expect(inspectGroup(broken).status).toBe("corrupt");
    }
    expect(
      inspectGroup({ schema: 1, seq: 1, name: "X", parentId: ROOT, icon: 1 }),
    ).toMatchObject({ value: { icon: { name: "folder" } } });
  });
});

describe("changes and merge", () => {
  const raw = {
    schema: 1,
    seq: 4,
    name: "A",
    notes: "n",
    future: { kept: true },
  };

  it("changes known fields, keeps unknown ones and counts seq", () => {
    const next = applyObjectChange(raw, { name: "B", notes: undefined }, LATER);
    expect(next).toEqual({
      schema: 1,
      seq: 5,
      name: "B",
      future: { kept: true },
      modified: LATER.now,
      modifiedBy: USER,
    });
    expect(raw.name).toBe("A");
    expect(() => applyObjectChange(raw, { seq: 9 }, LATER)).toThrow();
    const odd = applyObjectChange(raw, { ["__proto__"]: "x" }, LATER);
    expect(Object.prototype.hasOwnProperty.call(odd, "__proto__")).toBe(true);
  });

  it("applies local changes the server did not touch", () => {
    const local = applyObjectChange(raw, { name: "Local" }, LATER);
    const server = { ...raw, seq: 6, notes: "server", extra: 1 };
    const { merged, discarded } = mergeObject(raw, local, server, LATER);
    expect(discarded).toEqual([]);
    expect(merged).toMatchObject({
      name: "Local",
      notes: "server",
      extra: 1,
      seq: 7,
      modified: LATER.now,
    });
  });

  it("lets the server win where both changed a field", () => {
    const local = applyObjectChange(
      raw,
      { name: "Local", notes: undefined },
      LATER,
    );
    const server = { ...raw, seq: 5, name: "Server", notes: "server" };
    const { merged, discarded } = mergeObject(raw, local, server, LATER);
    expect(merged.name).toBe("Server");
    expect(merged.notes).toBe("server");
    expect(discarded).toEqual([
      { field: "name", value: "Local" },
      { field: "notes", value: undefined },
    ]);
    // The same new value on both sides is no conflict.
    const same = mergeObject(raw, local, { ...raw, name: "Local" }, LATER);
    expect(same.discarded).toEqual([]);
    expect("notes" in same.merged).toBe(false);
    // A field removed locally and untouched on the server goes.
    const removed = mergeObject(
      raw,
      applyObjectChange(raw, { notes: undefined }, LATER),
      raw,
      LATER,
    );
    expect("notes" in removed.merged).toBe(false);
  });

  it("compares content without bookkeeping", () => {
    const a = newGroup({ name: "X", parentId: ROOT }, STAMP);
    const b = { ...newGroup({ name: "X", parentId: ROOT }, LATER), seq: 3 };
    expect(sameContent(a, b)).toBe(true);
    expect(sameContent(a, { ...b, name: "Y" })).toBe(false);
  });
});

describe("names and the tree", () => {
  it("normalizes names", () => {
    expect(normalizeName("  Bank  ")).toBe("Bank");
    expect(normalizeName("   ")).toBeUndefined();
    expect(normalizeName("😀".repeat(256))).toBe("😀".repeat(256));
    expect(normalizeName("x".repeat(257))).toBeUndefined();
  });

  it("reads valid timestamps only", () => {
    expect(timestampOf({ modified: STAMP.now }, "modified")).toBe(STAMP.now);
    expect(timestampOf({ modified: "yesterday" }, "modified")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  applyEntryEdit,
  draftOf,
  emptyDraft,
  inspectEntry,
  newEntry,
  restoreEntrySnapshot,
  validateEntryDraft,
  withoutInvalidElements,
  type Entry,
  type SaveContext,
} from "../../src/model/entry";
import { EntryTooLarge } from "../../src/model/history";

const GROUP = "0192b3a4-5c6d-7e8f-9a0b-000000000002";
const OTHER = "0192b3a4-5c6d-7e8f-9a0b-000000000003";
const USER = "0192b3a4-5c6d-7e8f-9a0b-000000000009";
const F1 = "0192b3a4-5c6d-7e8f-9a0b-0000000000f1";
const F2 = "0192b3a4-5c6d-7e8f-9a0b-0000000000f2";
const KEY = "A".repeat(43);

let counter = 0;
function context(
  now = "2026-10-23T08:00:00.000Z",
  historyMaxItems = 10,
): SaveContext {
  return {
    stamp: { now, userId: USER },
    historyMaxItems,
    newId: () =>
      `0192b3a4-5c6d-7e8f-9a0b-${(++counter).toString().padStart(12, "0")}`,
  };
}

function ok(raw: Record<string, unknown>): Entry {
  const inspected = inspectEntry(raw);
  if (inspected.status !== "ok") throw new Error("corrupt");
  return inspected.value;
}

function entry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: 1, seq: 1, parentId: GROUP, title: "Mail", ...extra };
}

describe("entry validation", () => {
  it("is corrupt without schema, seq or parentId", () => {
    expect(inspectEntry({ schema: 1, seq: 1 }).status).toBe("corrupt");
    expect(inspectEntry({ schema: 1, seq: 0, parentId: GROUP }).status).toBe(
      "corrupt",
    );
    expect(inspectEntry({ seq: 1, parentId: GROUP }).status).toBe("corrupt");
    expect(inspectEntry({ schema: 1, seq: 1, parentId: "x" }).status).toBe(
      "corrupt",
    );
  });

  it("uses defaults for invalid scalars", () => {
    const value = ok(
      entry({
        title: 5,
        username: null,
        otp: 3,
        icon: { type: "x" },
        expires: "soon",
        sortKey: 1,
      }),
    );
    expect(value).toMatchObject({
      title: "",
      username: "",
      otp: null,
      icon: null,
      expires: null,
      sortKey: "",
      fields: [],
      tags: [],
      history: [],
      invalid: 0,
    });
    expect(inspectEntry(entry({ schema: 2 }))).toMatchObject({
      readOnly: true,
    });
  });

  it("counts invalid list elements, also in snapshots", () => {
    const value = ok(
      entry({
        fields: [
          { id: F1, name: "Host", value: "h" },
          { id: "x", name: "Bad", value: "b" },
          { id: F2, name: "P", value: "v", protected: "yes" },
        ],
        tags: ["a", 1],
        attachments: [
          {
            id: F1,
            name: "a.pdf",
            mime: "application/pdf",
            size: 3,
            key: KEY,
            compression: "none",
          },
          {
            id: F2,
            name: "b",
            mime: "x",
            size: -1,
            key: KEY,
            compression: "none",
          },
        ],
        history: [
          5,
          { schema: 1, fields: "x" },
          { schema: 2, title: "new", conflict: true },
        ],
      }),
    );
    expect(value.fields).toEqual([
      { id: F1, name: "Host", value: "h", protected: false },
    ]);
    expect(value.tags).toEqual(["a"]);
    expect(value.attachments).toEqual([
      {
        id: F1,
        name: "a.pdf",
        mime: "application/pdf",
        size: 3,
        compression: "none",
      },
    ]);
    expect(value.invalid).toBe(6);
    expect(
      value.history.map((s) => [s.unreadable, s.readOnly, s.conflict]),
    ).toEqual([
      [true, true, false],
      [false, false, false],
      [false, true, true],
    ]);
    expect(ok(entry({ fields: "x", history: {} })).invalid).toBe(2);
  });
});

describe("draft rules", () => {
  it("checks field names when the fields changed", () => {
    const draft = emptyDraft();
    draft.fields = [
      { name: " ", value: "", protected: false },
      { name: "x".repeat(129), value: "", protected: false },
      { name: "UserName", value: "", protected: false },
      { name: "Host", value: "", protected: false },
      { name: "HOST", value: "", protected: false },
      { name: "😀".repeat(128), value: "", protected: false },
    ];
    expect(validateEntryDraft(draft, undefined)).toEqual([
      { kind: "field_name_empty", index: 0 },
      { kind: "field_name_too_long", index: 1 },
      { kind: "field_name_reserved", index: 2 },
      { kind: "field_name_duplicate", index: 4 },
    ]);
    const stored = ok(entry({ fields: [{ id: F1, name: "otp", value: "" }] }));
    expect(validateEntryDraft(draftOf(stored), stored)).toEqual([]);
    draft.fields = Array.from({ length: 101 }, (_, i) => ({
      name: `f${String(i)}`,
      value: "",
      protected: false,
    }));
    expect(validateEntryDraft(draft, undefined)).toEqual([
      { kind: "too_many_fields" },
    ]);
  });

  it("checks tags and expiry", () => {
    const draft = emptyDraft();
    draft.tags = ["ok", " ", "a,b", "c;d", "OK", "x".repeat(129)];
    draft.expires = "tomorrow";
    expect(validateEntryDraft(draft, undefined)).toEqual([
      { kind: "tag_invalid", index: 1 },
      { kind: "tag_invalid", index: 2 },
      { kind: "tag_invalid", index: 3 },
      { kind: "tag_duplicate", index: 4 },
      { kind: "tag_invalid", index: 5 },
      { kind: "expires_invalid" },
    ]);
  });
});

describe("saving entries", () => {
  it("creates entries with new field IDs", () => {
    const draft = emptyDraft();
    draft.title = "Mail";
    draft.tags = [" work "];
    draft.fields = [{ name: " Host ", value: "h", protected: true }];
    const raw = newEntry({ parentId: GROUP, sortKey: "a0", draft }, context());
    const value = ok(raw);
    expect(value).toMatchObject({
      title: "Mail",
      tags: ["work"],
      sortKey: "a0",
      history: [],
    });
    expect(value.fields[0]).toMatchObject({
      name: "Host",
      value: "h",
      protected: true,
    });
    expect(raw).toMatchObject({
      seq: 1,
      otp: null,
      attachments: [],
      modifiedBy: USER,
    });
    draft.notes = "x".repeat(1024 * 1024);
    expect(() =>
      newEntry({ parentId: GROUP, sortKey: "", draft }, context()),
    ).toThrow(EntryTooLarge);
  });

  it("writes only changed fields and keeps unknown keys", () => {
    const base = entry({
      title: 7,
      future: { a: 1 },
      icon: { type: "builtin", name: "server", extra: true },
      fields: [{ id: F1, name: "Host", value: "h", tint: "red" }],
    });
    const draft = draftOf(ok(base));
    expect(applyEntryEdit(base, draft, context())).toBeUndefined();
    draft.username = "root";
    const next = applyEntryEdit(base, draft, context()) ?? {};
    expect(next.title).toBe(7);
    expect(next.future).toEqual({ a: 1 });
    expect(next.icon).toEqual({ type: "builtin", name: "server", extra: true });
    expect(next).toMatchObject({ username: "root", seq: 2, modifiedBy: USER });
    draft.fields = [
      { id: F1, name: "Host", value: "h2", protected: false },
      { name: "New", value: "n", protected: false },
    ];
    const withFields = applyEntryEdit(base, draft, context()) ?? {};
    expect((withFields.fields as unknown[])[0]).toEqual({
      id: F1,
      name: "Host",
      value: "h2",
      tint: "red",
    });
    expect((withFields.fields as unknown[])[1]).toMatchObject({
      name: "New",
      protected: false,
    });
  });

  it("adds a snapshot for content changes only", () => {
    const base = entry({
      seq: 4,
      modified: "2026-10-22T08:00:00.000Z",
      history: [{ schema: 1, title: "Old" }],
    });
    const draft = draftOf(ok(base));
    draft.title = "New";
    const next = applyEntryEdit(base, draft, context()) ?? {};
    const history = next.history as Record<string, unknown>[];
    expect(history.map((h) => h.title)).toEqual(["Mail", "Old"]);
    expect(history[0]).toMatchObject({
      seq: 4,
      modified: "2026-10-22T08:00:00.000Z",
    });
    expect(history[0]).not.toHaveProperty("history");
    const none = applyEntryEdit(base, draft, context(undefined, 0)) ?? {};
    expect(none.history).toEqual([]);
    const one = applyEntryEdit(base, draft, context(undefined, 1)) ?? {};
    expect((one.history as unknown[]).length).toBe(1);
  });

  it("drops the oldest snapshots to fit 1 MiB, then refuses", () => {
    const big = "x".repeat(400 * 1024);
    const base = entry({
      history: [
        { schema: 1, notes: big },
        { schema: 1, notes: big },
      ],
    });
    const draft = draftOf(ok(base));
    draft.notes = big;
    const next = applyEntryEdit(base, draft, context()) ?? {};
    // New snapshot (small) + one old snapshot; the oldest one went.
    expect((next.history as unknown[]).length).toBe(2);
    draft.notes = "y".repeat(1024 * 1024);
    expect(() => applyEntryEdit(base, draft, context())).toThrow(EntryTooLarge);
  });

  it("restores a snapshot without touching location and bookkeeping", () => {
    const base = entry({
      seq: 5,
      created: "2026-10-01T08:00:00.000Z",
      parentId: OTHER,
      sortKey: "a3",
      title: "Now",
      username: "u",
      added: true,
      history: [
        {
          schema: 1,
          seq: 3,
          parentId: GROUP,
          title: "Then",
          future: 1,
          conflict: true,
        },
        { schema: 2 },
      ],
    });
    const next = restoreEntrySnapshot(base, 0, context()) ?? {};
    expect(next).toMatchObject({
      seq: 6,
      parentId: OTHER,
      sortKey: "a3",
      created: "2026-10-01T08:00:00.000Z",
      title: "Then",
      future: 1,
      modifiedBy: USER,
    });
    expect(next).not.toHaveProperty("username");
    expect(next).not.toHaveProperty("added");
    expect(next).not.toHaveProperty("conflict");
    expect((next.history as Record<string, unknown>[])[0]).toMatchObject({
      title: "Now",
      added: true,
    });
    expect(() => restoreEntrySnapshot(base, 1, context())).toThrow();
    expect(() => restoreEntrySnapshot(base, 5, context())).toThrow();
    const same = entry({
      history: [{ schema: 1, parentId: GROUP, title: "Mail" }],
    });
    expect(restoreEntrySnapshot(same, 0, context())).toBeUndefined();
  });

  it("removes invalid elements without a snapshot", () => {
    const base = entry({
      fields: [{ id: F1, name: "a", value: "b" }, { id: "x" }],
      tags: ["t", 2],
      attachments: "x",
      history: [3, { schema: 1, tags: [1, "u"] }],
    });
    const next = withoutInvalidElements(base, context().stamp);
    expect(ok(next)).toMatchObject({
      invalid: 0,
      tags: ["t"],
      attachments: [],
    });
    expect((next.fields as unknown[]).length).toBe(1);
    expect(next.history).toEqual([{ schema: 1, tags: ["u"] }]);
    expect(next.seq).toBe(2);
  });
});

describe("TOTP in entries", () => {
  const URI =
    "otpauth://totp/Mail:me?secret=jbsw%20y3dp%20ehpk%203pxp&issuer=Mail";
  const NORMALIZED =
    "otpauth://totp/Mail:me?secret=JBSWY3DPEHPK3PXP&issuer=Mail";

  it("accepts a readable TOTP URI and stores it normalised", () => {
    const draft = { ...emptyDraft(), title: "Mail", otp: ` ${URI} ` };
    expect(validateEntryDraft(draft, undefined)).toEqual([]);
    const raw = newEntry({ parentId: GROUP, sortKey: "a0", draft }, context());
    expect(raw.otp).toBe(NORMALIZED);
    const changed = draftOf(ok(raw));
    changed.otp = null;
    const removed = applyEntryEdit(raw, changed, context()) ?? {};
    expect(removed.otp).toBeNull();
    expect((removed.history as Record<string, unknown>[])[0]?.otp).toBe(
      NORMALIZED,
    );
  });

  it("refuses new HOTP, Steam, migration and unreadable values", () => {
    const check = (otp: string) =>
      validateEntryDraft({ ...emptyDraft(), otp }, undefined);
    expect(check("otpauth://hotp/x?secret=MFRGG&counter=1")).toEqual([
      { kind: "otp_unsupported" },
    ]);
    expect(check("otpauth://totp/x?secret=MFRGG&encoder=steam")).toEqual([
      { kind: "otp_unsupported" },
    ]);
    expect(check("otpauth-migration://offline?data=abc")).toEqual([
      { kind: "otp_migration" },
    ]);
    expect(check("JBSWY3DPEHPK3PXP")).toEqual([{ kind: "otp_invalid" }]);
    expect(check("otpauth://totp/x?secret=1")).toEqual([
      { kind: "otp_invalid" },
    ]);
  });

  it("keeps an unchanged value this version cannot use", () => {
    const hotp = "otpauth://hotp/x?secret=MFRGG&counter=1";
    const base = entry({ otp: hotp });
    const draft = draftOf(ok(base));
    expect(validateEntryDraft(draft, ok(base))).toEqual([]);
    draft.username = "root";
    const next = applyEntryEdit(base, draft, context()) ?? {};
    expect(next.otp).toBe(hotp);
    // A stored URI that is readable but not normalised stays as it is, too.
    const loose = entry({ otp: URI });
    const unchanged = draftOf(ok(loose));
    unchanged.username = "x";
    expect((applyEntryEdit(loose, unchanged, context()) ?? {}).otp).toBe(URI);
  });
});

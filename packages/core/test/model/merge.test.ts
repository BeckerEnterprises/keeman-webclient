import { describe, expect, it } from "vitest";
import { EntryTooLarge } from "../../src/model/history";
import { mergeEntry } from "../../src/model/merge";
import { mergeObject } from "../../src/model/vault";

const USER = "0192b3a4-5c6d-7e8f-9a0b-000000000009";
const A = "0192b3a4-5c6d-7e8f-9a0b-00000000000a";
const B = "0192b3a4-5c6d-7e8f-9a0b-00000000000b";
const STAMP = { now: "2026-10-23T10:00:00.000Z", userId: USER };

const base = {
  schema: 1,
  seq: 3,
  parentId: A,
  sortKey: "a0",
  title: "T",
  username: "u",
  password: "p",
  history: [],
};

describe("entry merge", () => {
  it("keeps both changes to different fields", () => {
    const local = {
      ...base,
      seq: 4,
      username: "local",
      history: [{ title: "T" }],
    };
    const server = {
      ...base,
      seq: 5,
      password: "server",
      history: [{ schema: 1, title: "T", password: "p" }],
    };
    const { merged, conflicts } = mergeEntry(base, local, server, STAMP, 10);
    expect(conflicts).toEqual([]);
    expect(merged).toMatchObject({
      username: "local",
      password: "server",
      seq: 6,
      modifiedBy: USER,
    });
    const history = merged.history as Record<string, unknown>[];
    // A snapshot of the server version, then the server history.
    expect(history.map((h) => [h.username, h.password])).toEqual([
      ["u", "server"],
      [undefined, "p"],
    ]);
  });

  it("lets the server win a field and keeps the local version as conflict", () => {
    const local = { ...base, seq: 4, password: "mine", notes: "n" };
    const server = {
      ...base,
      seq: 4,
      password: "theirs",
      history: [{ schema: 1, password: "p" }],
    };
    const { merged, conflicts } = mergeEntry(base, local, server, STAMP, 10);
    expect(conflicts).toEqual(["password"]);
    expect(merged).toMatchObject({ password: "theirs", notes: "n" });
    const history = merged.history as Record<string, unknown>[];
    expect(history[0]).toMatchObject({
      password: "mine",
      conflict: true,
      notes: "n",
    });
    expect(history[0]).not.toHaveProperty("history");
    expect(history[1]).toMatchObject({ password: "theirs" });
    expect(history[2]).toMatchObject({ password: "p" });
    expect(history).toHaveLength(3);
  });

  it("takes the location as a unit", () => {
    const moved = { ...base, parentId: B, sortKey: "a5" };
    expect(
      mergeEntry(base, moved, { ...base, title: "S" }, STAMP, 10).merged,
    ).toMatchObject({
      parentId: B,
      sortKey: "a5",
      title: "S",
    });
    const trashed = { ...base, parentId: B, previousParentId: A };
    const serverMoved = { ...base, sortKey: "a9" };
    const result = mergeEntry(base, trashed, serverMoved, STAMP, 10);
    expect(result.merged).toMatchObject({ parentId: A, sortKey: "a9" });
    expect(result.merged).not.toHaveProperty("previousParentId");
    expect(result.conflicts).toEqual([]);
    // Only a move on both sides: no snapshot.
    expect(result.merged.history).toEqual([]);
  });

  it("refuses when the conflict snapshot cannot be stored", () => {
    const local = { ...base, password: "mine" };
    const server = { ...base, password: "theirs" };
    expect(() => mergeEntry(base, local, server, STAMP, 0)).toThrow(
      EntryTooLarge,
    );
    const big = { ...base, password: "theirs", notes: "x".repeat(700 * 1024) };
    expect(() =>
      mergeEntry(
        base,
        { ...local, notes: "y".repeat(400 * 1024) },
        big,
        STAMP,
        10,
      ),
    ).toThrow(EntryTooLarge);
    // Without a conflict a full history is no reason to refuse.
    expect(
      mergeEntry(base, { ...base, username: "x" }, server, STAMP, 0).merged
        .history,
    ).toEqual([]);
  });

  it("merges a group's location as one field", () => {
    const group = { schema: 1, seq: 1, parentId: A, sortKey: "a0", name: "G" };
    const local = { ...group, parentId: B, previousParentId: A };
    const result = mergeObject(
      group,
      local,
      { ...group, sortKey: "a7", name: "H" },
      STAMP,
    );
    expect(result.discarded).toEqual([]);
    expect(result.merged).toMatchObject({
      parentId: A,
      sortKey: "a7",
      name: "H",
    });
    expect(result.merged).not.toHaveProperty("previousParentId");
    const moved = mergeObject(group, local, { ...group, name: "H" }, STAMP);
    expect(moved.merged).toMatchObject({
      parentId: B,
      previousParentId: A,
      name: "H",
    });
  });
});

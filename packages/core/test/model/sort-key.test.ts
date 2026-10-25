import { describe, expect, it } from "vitest";
import {
  isSortKey,
  keyAtEnd,
  keysForInsert,
  siblingOrder,
  type Sibling,
} from "../../src/model/sort-key";

const collator = new Intl.Collator("de", {
  numeric: true,
  sensitivity: "base",
});
const order = siblingOrder(collator);

function sibling(id: string, sortKey: string, name = id): Sibling {
  return { id, sortKey, name };
}

describe("sort keys", () => {
  it("knows valid keys", () => {
    expect(isSortKey("a0")).toBe(true);
    expect(isSortKey("a0V")).toBe(true);
    expect(isSortKey("")).toBe(false);
    expect(isSortKey("zz")).toBe(false);
    expect(isSortKey("a00")).toBe(false);
  });

  it("orders by key, then name with numbers, then ID", () => {
    const list = [
      sibling("c", "a1"),
      sibling("b", "", "Server 10"),
      sibling("a", "", "Server 2"),
      sibling("e", "a0", "x"),
      sibling("d", "a0", "x"),
    ].sort(order);
    expect(list.map((s) => s.id)).toEqual(["a", "b", "d", "e", "c"]);
  });

  it("inserts between neighbours without touching them", () => {
    const list = [sibling("a", "a0"), sibling("b", "a1")];
    const result = keysForInsert(list, 1, 2);
    expect(result.rekey.size).toBe(0);
    expect(result.keys).toHaveLength(2);
    const [k1 = "", k2 = ""] = result.keys;
    expect("a0" < k1 && k1 < k2 && k2 < "a1").toBe(true);
    expect(keysForInsert([], 0, 1).keys).toEqual(["a0"]);
    expect(keysForInsert(list, 2, 1).keys).toEqual(["a2"]);
    expect(keysForInsert(list, 0, 1).keys[0] ?? "").toMatch(/^Z/);
  });

  it("gives every sibling a new key when neighbours are unusable", () => {
    const duplicates = [
      sibling("a", "a0"),
      sibling("b", "a0"),
      sibling("c", "a1"),
    ];
    const result = keysForInsert(duplicates, 1, 1);
    expect(result.keys).toEqual(["a1"]);
    expect([...result.rekey]).toEqual([
      ["b", "a2"],
      ["c", "a3"],
    ]);
    const empty = [sibling("a", ""), sibling("b", "")];
    const atEnd = keysForInsert(empty, 2, 1);
    expect(atEnd.keys).toEqual(["a2"]);
    expect([...atEnd.rekey]).toEqual([
      ["a", "a0"],
      ["b", "a1"],
    ]);
  });

  it("puts entries after every valid key", () => {
    expect(keyAtEnd([])).toBe("a0");
    expect(keyAtEnd(["", "zz", "a3", "a1"])).toBe("a4");
  });
});

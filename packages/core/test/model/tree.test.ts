import { describe, expect, it } from "vitest";
import { siblingOrder } from "../../src/model/sort-key";
import {
  ancestors,
  buildTree,
  isWithin,
  subtree,
  type TreeEntryInput,
  type TreeGroupInput,
  type TreeInput,
} from "../../src/model/tree";

const order = siblingOrder(new Intl.Collator("en", { numeric: true }));

function g(
  id: string,
  parentId: string | null,
  extra: Partial<TreeGroupInput> = {},
): TreeGroupInput {
  return { id, parentId, sortKey: "", name: id, modified: undefined, ...extra };
}

function e(id: string, parentId: string): TreeEntryInput {
  return { id, parentId, sortKey: "", title: id };
}

function tree(
  groups: TreeGroupInput[],
  entries: TreeEntryInput[] = [],
  options: Partial<TreeInput> = {},
) {
  return buildTree({
    rootId: "root",
    binId: "bin",
    fallbackRootId: "vault",
    groups: new Map(groups.map((x) => [x.id, x])),
    entries: new Map(entries.map((x) => [x.id, x])),
    order,
    ...options,
  });
}

describe("tree", () => {
  it("builds root, bin, depth and trash", () => {
    const layout = tree(
      [
        g("root", null),
        g("bin", "root"),
        g("a", "root"),
        g("a1", "a"),
        g("t", "bin"),
      ],
      [e("x", "a1"), e("y", "t"), e("z", "bin")],
    );
    expect(layout.rootId).toBe("root");
    expect(layout.missingRoot).toBe(false);
    expect(layout.binId).toBe("bin");
    expect(layout.children.get("root")).toEqual(["a", "bin"]);
    expect(layout.depth.get("a1")).toBe(2);
    expect([...layout.inTrash].sort()).toEqual(["t", "y", "z"]);
    expect(layout.problems.size).toBe(0);
    expect(layout.entries.get("a1")).toEqual(["x"]);
    expect(ancestors(layout, "x")).toEqual(["root", "a", "a1"]);
    expect(isWithin(layout, "x", "a")).toBe(true);
    expect(isWithin(layout, "a", "a")).toBe(true);
    expect(isWithin(layout, "y", "a")).toBe(false);
    expect(subtree(layout, "a")).toEqual({
      groups: ["a", "a1"],
      entries: ["x"],
    });
  });

  it("ignores the root's own parent", () => {
    const layout = tree([g("root", "a"), g("a", "root")]);
    expect(layout.parent.get("a")).toBe("root");
    expect(layout.problems.size).toBe(0);
  });

  it("hangs orphans below the root", () => {
    const layout = tree(
      [g("root", null), g("a", "gone"), g("b", null), g("c", "x")],
      [e("x", "root"), e("y", "gone"), e("w", "x")],
    );
    expect(layout.children.get("root")).toEqual(["a", "b", "c"]);
    expect(layout.problems.get("a")).toBe("orphan");
    expect(layout.problems.get("b")).toBe("orphan");
    // An entry is no parent.
    expect(layout.problems.get("c")).toBe("orphan");
    expect(layout.problems.get("w")).toBe("orphan");
    expect(layout.problems.get("y")).toBe("orphan");
    expect(layout.problems.has("x")).toBe(false);
  });

  it("breaks cycles at the newest member, ties by ID", () => {
    const layout = tree([
      g("root", null),
      g("a", "b", { modified: "2026-10-23T08:00:00.000Z" }),
      g("b", "a", { modified: "2026-10-23T09:00:00.000Z" }),
      g("c", "a"),
      g("p", "r"),
      g("q", "p"),
      g("r", "q"),
      g("s", "s"),
    ]);
    expect(layout.problems.get("b")).toBe("cycle");
    expect(layout.parent.get("b")).toBe("root");
    expect(layout.parent.get("a")).toBe("b");
    expect(layout.parent.get("c")).toBe("a");
    expect(layout.problems.get("p")).toBe("cycle");
    expect(layout.parent.get("q")).toBe("p");
    expect(layout.problems.get("s")).toBe("cycle");
    expect(layout.depth.get("c")).toBe(3);
  });

  it("stands in for a missing root", () => {
    const layout = tree([g("a", "root"), g("b", null)], [e("x", "root")]);
    expect(layout.missingRoot).toBe(true);
    expect(layout.rootId).toBe("root");
    expect(layout.problems.has("a")).toBe(false);
    expect(layout.problems.get("b")).toBe("orphan");
    expect(layout.entries.get("root")).toEqual(["x"]);
    const noMeta = tree([g("a", "root")], [], { rootId: undefined });
    expect(noMeta.rootId).toBe("vault");
    expect(noMeta.problems.get("a")).toBe("orphan");
  });

  it("has no bin when it is the root or missing", () => {
    expect(
      tree([g("root", null)], [], { binId: "root" }).binId,
    ).toBeUndefined();
    expect(tree([g("root", null)]).binId).toBeUndefined();
    expect(tree([g("root", null)], [], { binId: null }).binId).toBeUndefined();
  });
});

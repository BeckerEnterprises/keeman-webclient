import { describe, expect, it } from "vitest";
import {
  referencedAttachments,
  storedAttachment,
  unreferenced,
} from "../../src/attachments/refs";

const KEY_A = "A".repeat(43);
const KEY_B = "B".repeat(42) + "A";

function element(id: string, key = KEY_A, extra = {}) {
  return {
    id,
    name: id,
    mime: "text/plain",
    size: 3,
    key,
    compression: "none",
    ...extra,
  };
}

describe("attachment references", () => {
  it("collects the current content and every snapshot", () => {
    const raw = {
      attachments: [element("a"), { name: "no id" }],
      history: [
        { attachments: [element("b")] },
        "not an object",
        { attachments: "not a list" },
        { attachments: [element("a"), element("c")] },
      ],
    };
    expect([...referencedAttachments(raw)].sort()).toEqual(["a", "b", "c"]);
    expect(referencedAttachments({})).toEqual(new Set());
  });

  it("names what the new version no longer needs", () => {
    const before = {
      attachments: [element("a"), element("b")],
      history: [{ attachments: [element("c")] }],
    };
    const after = {
      attachments: [element("a")],
      history: [{ attachments: [element("a"), element("b")] }],
    };
    expect(unreferenced(before, after)).toEqual(["c"]);
    expect(unreferenced(after, before)).toEqual([]);
  });

  it("finds the stored element, current content first", () => {
    const raw = {
      attachments: [element("a", KEY_A)],
      history: [
        {
          attachments: [
            element("a", KEY_B),
            element("b", KEY_B, { compression: "gzip" }),
          ],
        },
        {
          attachments: [
            element("x", KEY_A, { size: -1 }),
            element("y", 7 as unknown as string),
          ],
        },
      ],
    };
    expect(storedAttachment(raw, "a")?.key).toBe(KEY_A);
    expect(storedAttachment(raw, "b")).toEqual({
      id: "b",
      key: KEY_B,
      compression: "gzip",
      size: 3,
    });
    expect(storedAttachment(raw, "x")).toBeUndefined();
    expect(storedAttachment(raw, "y")).toBeUndefined();
    expect(storedAttachment(raw, "nope")).toBeUndefined();
  });
});

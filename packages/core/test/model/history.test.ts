import { describe, expect, it } from "vitest";
import {
  applyEntryEdit,
  draftOf,
  inspectEntry,
  restoreEntrySnapshot,
  type SaveContext,
} from "../../src/model/entry";
import {
  changedFields,
  contentKeys,
  sameEntryContent,
  utf8Length,
} from "../../src/model/history";

const GROUP = "0192b3a4-5c6d-7e8f-9a0b-000000000002";
const USER = "0192b3a4-5c6d-7e8f-9a0b-000000000009";

/** Small seeded PRNG (mulberry32), so failures are reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function content(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    contentKeys(raw)
      .sort()
      .map((k) => [k, raw[k]]),
  );
}

describe("history", () => {
  it("measures UTF-8 bytes", () => {
    expect(utf8Length("aä€😀")).toBe(1 + 2 + 3 + 4);
    expect(utf8Length(JSON.stringify({ a: "😀" }))).toBe(
      new TextEncoder().encode('{"a":"😀"}').length,
    );
  });

  it("compares content without location and bookkeeping", () => {
    const a = {
      schema: 1,
      seq: 1,
      parentId: "x",
      sortKey: "a0",
      title: "T",
      history: [1],
    };
    const b = {
      schema: 1,
      seq: 9,
      parentId: "y",
      previousParentId: "x",
      title: "T",
      modified: "m",
    };
    expect(sameEntryContent(a, b)).toBe(true);
    expect(changedFields(a, { ...b, title: "U", notes: "" })).toEqual([
      "notes",
      "title",
    ]);
  });

  it("restores every earlier state exactly (property test)", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const random = prng(seed);
      const pick = <T>(items: readonly T[]): T =>
        items[Math.floor(random() * items.length)] as T;
      let ids = 0;
      const ctx = (step: number): SaveContext => ({
        stamp: {
          now: new Date(Date.UTC(2026, 9, 23, 8, 0, step)).toISOString(),
          userId: USER,
        },
        historyMaxItems: 100,
        newId: () =>
          `0192b3a4-5c6d-7e8f-9a0b-${(++ids).toString().padStart(12, "0")}`,
      });
      let raw: Record<string, unknown> = {
        schema: 1,
        seq: 1,
        parentId: GROUP,
        sortKey: "a0",
        title: "Start",
        future: { v: 0 },
      };
      // Every content state the entry had, newest last.
      const states = [content(raw)];
      for (let step = 1; step <= 12; step++) {
        const inspected = inspectEntry(raw);
        if (inspected.status !== "ok") throw new Error("corrupt");
        const action = random();
        let next: Record<string, unknown> | undefined;
        if (action < 0.15) {
          // A move is no content change.
          raw = { ...raw, sortKey: `a${String(step)}` };
          continue;
        } else if (action < 0.35 && inspected.value.history.length > 0) {
          next = restoreEntrySnapshot(
            raw,
            Math.floor(random() * inspected.value.history.length),
            ctx(step),
          );
        } else {
          const draft = draftOf(inspected.value);
          const field = pick([
            "title",
            "username",
            "password",
            "url",
            "notes",
          ] as const);
          draft[field] =
            `${field}-${String(step)}-${String(Math.floor(random() * 3))}`;
          if (random() < 0.3) draft.tags = [`t${String(step)}`];
          if (random() < 0.3)
            draft.fields = [
              ...draft.fields,
              {
                name: `F${String(step)}`,
                value: "v",
                protected: random() < 0.5,
              },
            ];
          next = applyEntryEdit(raw, draft, ctx(step));
        }
        if (next === undefined) continue;
        raw = next;
        states.push(content(raw));
      }
      const history = (raw.history ?? []) as Record<string, unknown>[];
      // history[i] holds the state before the (i+1)-th newest change.
      expect(history.length).toBe(states.length - 1);
      history.forEach((_, i) => {
        const restored = restoreEntrySnapshot(raw, i, ctx(99));
        const expected = states[states.length - 2 - i];
        const actual =
          restored === undefined ? content(raw) : content(restored);
        expect(actual, `seed ${String(seed)}, snapshot ${String(i)}`).toEqual(
          expected,
        );
        if (restored) {
          expect(restored.parentId).toBe(raw.parentId);
          expect(restored.sortKey).toBe(raw.sortKey);
          expect(restored.seq).toBe((raw.seq as number) + 1);
        }
      });
    }
  });
});

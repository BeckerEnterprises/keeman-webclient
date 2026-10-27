import { describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import de from "./de";
import en from "./en";

function keys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    keys(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("messages", () => {
  it("have the same keys in German and English", () => {
    expect(keys(en).sort()).toEqual(keys(de).sort());
  });

  it("all compile without the eval-based compiler", () => {
    const i18n = createI18n({
      legacy: false,
      locale: "de",
      messages: { de, en },
    });
    for (const locale of ["de", "en"] as const) {
      i18n.global.locale.value = locale;
      for (const key of keys(de)) {
        const text = i18n.global.t(key, {
          seconds: 1,
          email: "x",
          ops: 1,
          mem: 1,
          old: "a",
          new: "b",
          id: "i",
          version: "v",
          commit: "c",
          name: "n",
          count: 1,
          field: "f",
          value: "w",
          type: "t",
          reason: "r",
          groups: 1,
          entries: 2,
          date: "d",
          time: "t",
          bits: 64,
          tag: "g",
          where: "w",
          from: "a",
          to: "b",
          names: "n",
          problem: "p",
          size: 1,
          done: 1,
          total: 2,
        });
        expect(text, key).not.toBe(key);
        expect(text, key).not.toMatch(/[{}]/);
      }
    }
  });
});

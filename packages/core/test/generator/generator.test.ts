import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UniformSource } from "../../src/crypto/random";
import { EFF_WORDS } from "../../src/generator/eff-wordlist";
import { generateSecret, secretBits } from "../../src/generator/index";
import {
  GENERATOR_DEFAULTS,
  generatorOptionsOf,
  isGeneratorOptions,
  type GeneratorOptions,
} from "../../src/generator/options";
import { EFF_WORD_COUNT, pickPassphrase } from "../../src/generator/passphrase";
import {
  characterClasses,
  LOOKALIKES,
  passwordBits,
  pickPassword,
} from "../../src/generator/password";

function options(extra: Partial<GeneratorOptions> = {}): GeneratorOptions {
  return { ...GENERATOR_DEFAULTS, ...extra };
}

/** Returns the given values in order, so a test knows every draw. */
function sequence(values: number[]): UniformSource & { used: number } {
  const source = {
    used: 0,
    uniform(_label: string, upper: number) {
      const value = values[source.used++];
      if (value === undefined || value >= upper)
        throw new Error("sequence exhausted");
      return value;
    },
  };
  return source;
}

describe("password generator", () => {
  it("builds the classes and removes look-alikes", () => {
    const all = characterClasses(options({ excludeLookalikes: false }));
    expect(all.map((c) => c.length)).toEqual([26, 26, 10, 32]);
    const clean = characterClasses(options()).join("");
    for (const c of LOOKALIKES) expect(clean).not.toContain(c);
    expect(
      characterClasses(options({ upper: false, symbols: false })).join(""),
    ).toBe("abcdefghijkmnpqrstuvwxyz23456789");
  });

  it("draws again until every class is present", () => {
    const o = options({
      length: 4,
      symbols: false,
      upper: false,
      excludeLookalikes: false,
    });
    // Alphabet "a-z0-9": "aaaa" lacks a digit and is drawn again.
    const source = sequence([0, 0, 0, 0, 0, 26, 1, 27]);
    expect(pickPassword(source, o)).toBe("a0b1");
    expect(source.used).toBe(8);
    expect(() => pickPassword(sequence([]), options({ length: 3 }))).toThrow();
  });

  it("is uniform over the alphabet", () => {
    const o = options({ length: 128, excludeLookalikes: false });
    const counts = new Map<string, number>();
    let total = 0;
    for (let i = 0; i < 200; i++)
      for (const c of pickPassword(
        { uniform: (_l, upper) => Math.floor(Math.random() * upper) },
        o,
      )) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
        total++;
      }
    expect(counts.size).toBe(94);
    // Chi-squared with 93 degrees of freedom; 160 is far beyond p = 0.0001.
    const expected = total / 94;
    let chi = 0;
    for (const n of counts.values()) chi += (n - expected) ** 2 / expected;
    expect(chi).toBeLessThan(160);
  });

  it("counts the entropy exactly", () => {
    // Brute force: strings of length 3 over "ab" + "01" with both classes.
    const o = options({
      length: 3,
      upper: false,
      symbols: false,
      excludeLookalikes: false,
    });
    const small = { ...o };
    const sets = characterClasses(small);
    expect(sets.map((s) => s.length)).toEqual([26, 10]);
    let valid = 0;
    const alphabet = sets.join("");
    for (const a of alphabet)
      for (const b of alphabet)
        for (const c of alphabet) {
          const s = a + b + c;
          if (
            Array.from(s).some((x) => sets[0]?.includes(x)) &&
            Array.from(s).some((x) => sets[1]?.includes(x))
          )
            valid++;
        }
    expect(passwordBits(small)).toBeCloseTo(Math.log2(valid), 10);
    expect(
      passwordBits(options({ length: 128, excludeLookalikes: false })),
    ).toBeCloseTo(128 * Math.log2(94), 3);
    expect(secretBits(options({ mode: "words", words: 6 }))).toBeCloseTo(
      6 * Math.log2(7772),
      10,
    );
  });

  it("builds passphrases from the EFF list", async () => {
    expect(EFF_WORDS).toHaveLength(EFF_WORD_COUNT);
    expect(new Set(EFF_WORDS).size).toBe(EFF_WORD_COUNT);
    expect(EFF_WORDS.every((w) => /^[a-z]+$/.test(w))).toBe(true);
    expect(
      createHash("sha256").update(EFF_WORDS.join("\n")).digest("hex"),
    ).toBe("76e3348ad957cad7d9c5c68873e89410ed998c19f4956367ab52d9aec4eee884");
    const o = options({
      mode: "words",
      words: 3,
      separator: " ",
      capitalize: true,
    });
    expect(pickPassphrase(sequence([0, 1, 7771]), EFF_WORDS, o)).toBe(
      "Abacus Abdomen Zoom",
    );
    const phrase = await generateSecret(options({ mode: "words", words: 5 }));
    expect(phrase.split("-")).toHaveLength(5);
    const password = await generateSecret(options());
    expect(Array.from(password)).toHaveLength(24);
  });

  it("reads stored options with a default per field", () => {
    expect(generatorOptionsOf(undefined)).toEqual(GENERATOR_DEFAULTS);
    expect(
      generatorOptionsOf({
        mode: "words",
        length: 3,
        words: 21,
        separator: "abcd",
        capitalize: true,
        upper: "x",
      }),
    ).toEqual({ ...GENERATOR_DEFAULTS, mode: "words", capitalize: true });
    expect(
      generatorOptionsOf({
        upper: false,
        lower: false,
        digits: false,
        symbols: false,
      }),
    ).toEqual(GENERATOR_DEFAULTS);
    expect(isGeneratorOptions(options({ length: 30 }))).toBe(true);
    expect(isGeneratorOptions({ ...options(), length: 200 })).toBe(false);
    expect(isGeneratorOptions({ length: 30 })).toBe(false);
  });
});

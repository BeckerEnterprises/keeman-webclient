/**
 * Passwords from characters: uniform characters of the chosen
 * classes; a result without every chosen class is drawn again, which keeps
 * all valid passwords equally likely. The entropy is exact.
 */
import { systemUniform, type UniformSource } from "../crypto/random";
import type { GeneratorOptions } from "./options";

const CLASSES = {
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  lower: "abcdefghijklmnopqrstuvwxyz",
  digits: "0123456789",
  symbols: "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
} as const;

/** Removed by "exclude look-alikes". */
export const LOOKALIKES = "0Oo1lI|";

type ClassName = keyof typeof CLASSES;

/** The chosen classes, each without look-alikes if requested. */
export function characterClasses(options: GeneratorOptions): string[] {
  const names = (["upper", "lower", "digits", "symbols"] as ClassName[]).filter(
    (name) => options[name],
  );
  return names.map((name) =>
    options.excludeLookalikes
      ? Array.from(CLASSES[name])
          .filter((c) => !LOOKALIKES.includes(c))
          .join("")
      : CLASSES[name],
  );
}

/** Draws with an injected source; tests use a fixed sequence. */
export function pickPassword(
  source: UniformSource,
  options: GeneratorOptions,
): string {
  const classes = characterClasses(options);
  if (classes.length === 0 || options.length < classes.length)
    throw new Error("Impossible generator options");
  const alphabet = classes.join("");
  for (;;) {
    let result = "";
    for (let i = 0; i < options.length; i++)
      result += alphabet[source.uniform("password", alphabet.length)] ?? "";
    if (classes.every((set) => Array.from(set).some((c) => result.includes(c))))
      return result;
  }
}

export function generatePassword(options: GeneratorOptions): string {
  return pickPassword(systemUniform, options);
}

function log2(value: bigint): number {
  const bits = value.toString(2).length;
  if (bits <= 53) return Math.log2(Number(value));
  const shift = bits - 53;
  return Math.log2(Number(value >> BigInt(shift))) + shift;
}

/**
 * log2 of the number of passwords with at least one character of every
 * chosen class: inclusion-exclusion over the classes.
 */
export function passwordBits(options: GeneratorOptions): number {
  const sizes = characterClasses(options).map((set) => set.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  const length = BigInt(options.length);
  let count = 0n;
  for (let mask = 0; mask < 1 << sizes.length; mask++) {
    let missing = 0;
    let members = 0;
    sizes.forEach((size, i) => {
      if (mask & (1 << i)) {
        missing += size;
        members++;
      }
    });
    const term = BigInt(total - missing) ** length;
    count += members % 2 === 0 ? term : -term;
  }
  return count > 0n ? log2(count) : 0;
}

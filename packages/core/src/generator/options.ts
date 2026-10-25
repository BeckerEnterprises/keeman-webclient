/**
 * Options of the password generator with their limits.
 * Every option falls back to its default on its own.
 */
import { isJsonObject } from "../crypto/bytes";
import { own } from "../model/json";

export interface GeneratorOptions {
  mode: "chars" | "words";
  length: number;
  upper: boolean;
  lower: boolean;
  digits: boolean;
  symbols: boolean;
  excludeLookalikes: boolean;
  words: number;
  separator: string;
  capitalize: boolean;
}

export const GENERATOR_DEFAULTS: Readonly<GeneratorOptions> = Object.freeze({
  mode: "chars",
  length: 24,
  upper: true,
  lower: true,
  digits: true,
  symbols: true,
  excludeLookalikes: true,
  words: 6,
  separator: "-",
  capitalize: false,
});

export const GENERATOR_LIMITS = Object.freeze({
  minLength: 4,
  maxLength: 128,
  /** Below this length the UI warns. */
  warnLength: 12,
  minWords: 3,
  maxWords: 20,
  maxSeparator: 3,
});

function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Valid options from stored settings; invalid parts use the defaults. */
export function generatorOptionsOf(value: unknown): GeneratorOptions {
  const stored = isJsonObject(value) ? value : {};
  const flag = (
    key:
      | "upper"
      | "lower"
      | "digits"
      | "symbols"
      | "excludeLookalikes"
      | "capitalize",
  ) => {
    const v = own(stored, key);
    return typeof v === "boolean" ? v : GENERATOR_DEFAULTS[key];
  };
  const mode = own(stored, "mode");
  const length = own(stored, "length");
  const words = own(stored, "words");
  const separator = own(stored, "separator");
  const options: GeneratorOptions = {
    mode: mode === "chars" || mode === "words" ? mode : GENERATOR_DEFAULTS.mode,
    length: integer(
      length,
      GENERATOR_LIMITS.minLength,
      GENERATOR_LIMITS.maxLength,
    )
      ? length
      : GENERATOR_DEFAULTS.length,
    upper: flag("upper"),
    lower: flag("lower"),
    digits: flag("digits"),
    symbols: flag("symbols"),
    excludeLookalikes: flag("excludeLookalikes"),
    words: integer(words, GENERATOR_LIMITS.minWords, GENERATOR_LIMITS.maxWords)
      ? words
      : GENERATOR_DEFAULTS.words,
    separator:
      typeof separator === "string" &&
      separator.isWellFormed() &&
      Array.from(separator).length <= GENERATOR_LIMITS.maxSeparator
        ? separator
        : GENERATOR_DEFAULTS.separator,
    capitalize: flag("capitalize"),
  };
  // At least one class: otherwise all four defaults apply.
  if (!options.upper && !options.lower && !options.digits && !options.symbols) {
    options.upper = GENERATOR_DEFAULTS.upper;
    options.lower = GENERATOR_DEFAULTS.lower;
    options.digits = GENERATOR_DEFAULTS.digits;
    options.symbols = GENERATOR_DEFAULTS.symbols;
  }
  return options;
}

/** Whether `value` is a complete, valid set of options (for writing). */
export function isGeneratorOptions(value: unknown): value is GeneratorOptions {
  return (
    isJsonObject(value) &&
    JSON.stringify(generatorOptionsOf(value)) === JSON.stringify(value)
  );
}

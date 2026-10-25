/**
 * Passphrases from the EFF list: uniform words, a separator and
 * optionally a capital first letter. The list loads on first use.
 */
import { systemUniform, type UniformSource } from "../crypto/random";
import type { GeneratorOptions } from "./options";

/** Size of the list without words containing a hyphen; a test checks it. */
export const EFF_WORD_COUNT = 7772;

export function pickPassphrase(
  source: UniformSource,
  words: readonly string[],
  options: GeneratorOptions,
): string {
  const picked: string[] = [];
  for (let i = 0; i < options.words; i++) {
    const word = words[source.uniform("passphrase", words.length)] ?? "";
    picked.push(
      options.capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word,
    );
  }
  return picked.join(options.separator);
}

export async function generatePassphrase(
  options: GeneratorOptions,
): Promise<string> {
  const { EFF_WORDS } = await import("./eff-wordlist");
  return pickPassphrase(systemUniform, EFF_WORDS, options);
}

export function passphraseBits(options: GeneratorOptions): number {
  return options.words * Math.log2(EFF_WORD_COUNT);
}

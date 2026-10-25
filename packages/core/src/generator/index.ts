/** The password generator: one entry point per mode, the entropy. */
import { generatePassphrase, passphraseBits } from "./passphrase";
import { generatePassword, passwordBits } from "./password";
import type { GeneratorOptions } from "./options";

export {
  GENERATOR_DEFAULTS,
  GENERATOR_LIMITS,
  generatorOptionsOf,
  type GeneratorOptions,
} from "./options";

/** A new password or passphrase; never takes a source of randomness. */
export async function generateSecret(
  options: GeneratorOptions,
): Promise<string> {
  return options.mode === "words"
    ? generatePassphrase(options)
    : generatePassword(options);
}

/** Entropy in bits of what `generateSecret` returns for these options. */
export function secretBits(options: GeneratorOptions): number {
  return options.mode === "words"
    ? passphraseBits(options)
    : passwordBits(options);
}

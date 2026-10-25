// For tests and for producing test vectors only (ESLint keeps it out of src).
import type { Randomness } from "../random";

export interface ScriptedRandomness extends Randomness {
  /** Labels that were provided but never requested. */
  unused(): string[];
}

/**
 * Returns fixed values per label. Every label may be used once, so a nonce
 * can never be handed out twice by accident.
 */
export function scriptedRandomness(
  bytes: Record<string, Uint8Array>,
  ids: Record<string, string> = {},
): ScriptedRandomness {
  const used = new Set<string>();
  const take = (label: string): void => {
    if (used.has(label))
      throw new Error(`Scripted value "${label}" requested twice`);
    used.add(label);
  };
  return {
    bytes(label, length) {
      const value = bytes[label];
      if (!value) throw new Error(`No scripted bytes for "${label}"`);
      if (value.length !== length)
        throw new Error(
          `Scripted bytes for "${label}" must be ${String(length)} bytes`,
        );
      take(label);
      return value.slice();
    },
    id(label) {
      const value = ids[label];
      if (!value) throw new Error(`No scripted ID for "${label}"`);
      take(`id:${label}`);
      return value;
    },
    unused() {
      return [
        ...Object.keys(bytes).filter((label) => !used.has(label)),
        ...Object.keys(ids).filter((label) => !used.has(`id:${label}`)),
      ];
    },
  };
}

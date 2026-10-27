import { utf8Encode } from "./bytes";
import { CryptoError } from "./errors";
import { sodium } from "./sodium";

export const KEY_BYTES = 32;

/** KDF contexts, exactly 8 bytes each. */
export const KDF_CONTEXT = {
  account: "keeman01",
  recovery: "keemanRK",
  prf: "keemanPF",
  signing: "keemanSG",
} as const;

const CONTEXT_PATTERN = /^[\x20-\x7e]{8}$/;

/**
 * `crypto_kdf_derive_from_key(32, id, ctx, key)`, i.e. keyed BLAKE2b-256 with
 * salt = LE64(id) ‖ 0⁸ and personal = ctx ‖ 0⁸.
 */
export function deriveSubkey(
  key: Uint8Array,
  subkeyId: number,
  context: string,
): Uint8Array {
  if (key.length !== KEY_BYTES)
    throw new CryptoError("validation", "KDF key must be 32 bytes");
  if (!CONTEXT_PATTERN.test(context))
    throw new CryptoError(
      "validation",
      "KDF context must be 8 ASCII characters",
    );
  if (!Number.isSafeInteger(subkeyId) || subkeyId < 0)
    throw new CryptoError("validation", "Invalid subkey ID");
  return sodium().crypto_kdf_derive_from_key(
    KEY_BYTES,
    BigInt(subkeyId),
    context,
    key,
  );
}

export interface AccountKeys {
  authKey: Uint8Array;
  wrapKey: Uint8Array;
}

/** auth_key and wrap_key from the master key. */
export function deriveAccountKeys(masterKey: Uint8Array): AccountKeys {
  return {
    authKey: deriveSubkey(masterKey, 1, KDF_CONTEXT.account),
    wrapKey: deriveSubkey(masterKey, 2, KDF_CONTEXT.account),
  };
}

export interface RecoveryKeys {
  recoveryAuthKey: Uint8Array;
  recoveryWrapKey: Uint8Array;
}

/** recovery_auth_key and recovery_wrap_key from the recovery key. */
export function deriveRecoveryKeys(recoveryKey: Uint8Array): RecoveryKeys {
  return {
    recoveryAuthKey: deriveSubkey(recoveryKey, 1, KDF_CONTEXT.recovery),
    recoveryWrapKey: deriveSubkey(recoveryKey, 2, KDF_CONTEXT.recovery),
  };
}

/** prf_wrap_key from a passkey PRF output (planned for later). */
export function derivePrfWrapKey(prfOutput: Uint8Array): Uint8Array {
  return deriveSubkey(prfOutput, 1, KDF_CONTEXT.prf);
}

/** The PRF input `eval.first`. */
export function prfEvalFirst(): Uint8Array {
  return sodium().crypto_generichash(
    32,
    utf8Encode("keeman:v1:prf-unlock"),
    null,
  );
}

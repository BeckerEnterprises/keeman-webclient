// Crypto steps of the account flows as pure functions: inputs in,
// request-ready material out. The API calls follow in src/account.
// Build the material once per operation and resend it unchanged on retries.
import type { components } from "../../api/openapi.gen";
import { aad } from "../aad";
import {
  DEFAULT_KDF_PARAMS,
  SALT_BYTES,
  validateKdfParams,
  type KdfParams,
} from "../argon2";
import { toBase64Url, wipe, type JsonObject } from "../bytes";
import { openJson, openKey, sealJson, sealKey } from "../envelope";
import { CryptoError } from "../errors";
import { deriveRecoveryKeys, type AccountKeys } from "../kdf";
import { generateKeyPair, verifyOwnPublicKey } from "../keypair";
import type { AccountKeyMaterial } from "../keystore";
import { normalizeEmail } from "../normalize";
import { scoped, type Randomness } from "../random";
import {
  formatRecoveryKey,
  generateRecoveryKey,
  parseRecoveryKey,
} from "../recovery-key";
import { assertUuid } from "../uuid";

type Schemas = components["schemas"];

export interface PasswordSetup {
  salt: Uint8Array;
  kdf: KdfParams;
}

/** New salt and KDF parameters for registration, password change or recovery. */
export function newPasswordSetup(
  randomness: Randomness,
  kdf: KdfParams = DEFAULT_KDF_PARAMS,
): PasswordSetup {
  return {
    salt: randomness.bytes("salt", SALT_BYTES),
    kdf: validateKdfParams(kdf),
  };
}

export interface RecoveryMaterial {
  request: Schemas["RecoveryMaterial"];
  /** Display form for the user; never sent to the server. */
  recoveryKeyDisplay: string;
}

/** New recovery key with its auth key and the recovery-wrapped user key. */
export function buildRecoveryMaterial(
  randomness: Randomness,
  userId: string,
  userKey: Uint8Array,
): RecoveryMaterial {
  const recoveryKey = generateRecoveryKey(randomness);
  const { recoveryAuthKey, recoveryWrapKey } = deriveRecoveryKeys(recoveryKey);
  try {
    return {
      request: {
        auth_key: toBase64Url(recoveryAuthKey),
        user_key_wrapped: sealKey(
          scoped(randomness, "recovery_user_key_wrapped"),
          recoveryWrapKey,
          userKey,
          aad.recovery(userId),
        ),
      },
      recoveryKeyDisplay: formatRecoveryKey(recoveryKey),
    };
  } finally {
    wipe(recoveryKey, recoveryAuthKey, recoveryWrapKey);
  }
}

export interface RegistrationInput extends PasswordSetup {
  email: string;
  /** auth_key and wrap_key derived from the password and `salt` (argon2.ts or the worker). */
  loginKeys: AccountKeys;
  userData: JsonObject;
}

export type RegistrationRequest = Pick<
  Schemas["RegisterRequest"],
  | "user_id"
  | "email"
  | "kdf"
  | "salt"
  | "auth_key"
  | "user_key_wrapped"
  | "public_key"
  | "private_key_wrapped"
  | "recovery"
  | "user_data"
>;

export interface Registration {
  request: RegistrationRequest;
  recoveryKeyDisplay: string;
  account: AccountKeyMaterial;
}

/** Key material for `POST /v1/auth/register`. */
export function buildRegistration(
  randomness: Randomness,
  input: RegistrationInput,
): Registration {
  const userId = randomness.id("user_id");
  const userKey = randomness.bytes("user_key", 32);
  const { privateKey, publicKey } = generateKeyPair(randomness);
  const recovery = buildRecoveryMaterial(randomness, userId, userKey);
  return {
    request: {
      user_id: userId,
      email: normalizeEmail(input.email),
      kdf: validateKdfParams(input.kdf),
      salt: toBase64Url(input.salt),
      auth_key: toBase64Url(input.loginKeys.authKey),
      user_key_wrapped: sealKey(
        scoped(randomness, "user_key_wrapped"),
        input.loginKeys.wrapKey,
        userKey,
        aad.userKey(userId),
      ),
      public_key: toBase64Url(publicKey),
      private_key_wrapped: sealKey(
        scoped(randomness, "private_key_wrapped"),
        userKey,
        privateKey,
        aad.privateKey(userId),
      ),
      recovery: recovery.request,
      user_data: sealJson(
        scoped(randomness, "user_data"),
        userKey,
        input.userData,
        aad.userData(userId),
      ),
    },
    recoveryKeyDisplay: recovery.recoveryKeyDisplay,
    account: { userId, userKey, privateKey, publicKey },
  };
}

/** The fields of `GET /v1/me` needed to unlock. */
export type MeKeys = Pick<
  Schemas["Me"],
  | "user_id"
  | "user_key_wrapped"
  | "private_key_wrapped"
  | "public_key"
  | "user_data"
>;

export interface UnlockedAccount {
  account: AccountKeyMaterial;
  /** `undefined` if user_data could not be decrypted (it then counts as corrupt). */
  userData: JsonObject | undefined;
}

/**
 * Unlocks with wrap_key. A wrong wrap_key fails
 * with `auth`: during unlock that means a wrong password, right after a
 * successful login an integrity problem. Later failures are `integrity`.
 */
export function unlockAccount(
  me: MeKeys,
  wrapKey: Uint8Array,
): UnlockedAccount {
  assertUuid(me.user_id, "user_id");
  const userKey = openKey(
    wrapKey,
    me.user_key_wrapped,
    aad.userKey(me.user_id),
  );
  return unlockWithUserKey(me, userKey);
}

/**
 * Unlocks with a user key that is already open, e.g. the one a recovery
 * unwrapped. Takes ownership of `userKey`.
 */
export function unlockWithUserKey(
  me: MeKeys,
  userKey: Uint8Array,
): UnlockedAccount {
  const userId = me.user_id;
  let privateKey: Uint8Array | undefined;
  try {
    assertUuid(userId, "user_id");
    try {
      privateKey = openKey(
        userKey,
        me.private_key_wrapped,
        aad.privateKey(userId),
      );
    } catch {
      throw new CryptoError(
        "integrity",
        "Private key does not match the user key",
      );
    }
    const publicKey = verifyOwnPublicKey(privateKey, me.public_key);
    let userData: JsonObject | undefined;
    try {
      userData = openJson(userKey, me.user_data.data, aad.userData(userId));
    } catch {
      userData = undefined;
    }
    return { account: { userId, userKey, privateKey, publicKey }, userData };
  } catch (error) {
    wipe(userKey, privateKey);
    throw error;
  }
}

export interface PasswordChangeInput extends PasswordSetup {
  userId: string;
  userKey: Uint8Array;
  /** auth_key and wrap_key of the new password with the new salt. */
  loginKeys: AccountKeys;
}

/** Body of `PUT /v1/me/password`; the user key stays the same. */
export function buildPasswordChange(
  randomness: Randomness,
  input: PasswordChangeInput,
  revokeOtherSessions: boolean,
): Schemas["PasswordChangeRequest"] {
  return {
    kdf: validateKdfParams(input.kdf),
    salt: toBase64Url(input.salt),
    auth_key: toBase64Url(input.loginKeys.authKey),
    user_key_wrapped: sealKey(
      scoped(randomness, "user_key_wrapped"),
      input.loginKeys.wrapKey,
      input.userKey,
      aad.userKey(input.userId),
    ),
    revoke_other_sessions: revokeOtherSessions,
  };
}

export interface RecoveryStart {
  /** For `POST /v1/auth/recover/start`. */
  recoveryAuthKey: string;
  recoveryWrapKey: Uint8Array;
}

/** Parses the typed recovery key and derives its keys. */
export function startRecovery(recoveryKeyInput: string): RecoveryStart {
  const recoveryKey = parseRecoveryKey(recoveryKeyInput);
  const { recoveryAuthKey, recoveryWrapKey } = deriveRecoveryKeys(recoveryKey);
  wipe(recoveryKey);
  const encoded = toBase64Url(recoveryAuthKey);
  wipe(recoveryAuthKey);
  return { recoveryAuthKey: encoded, recoveryWrapKey };
}

/** Unwraps the user key from `RecoveryPayload`. */
export function unwrapRecoveredUserKey(
  recoveryWrapKey: Uint8Array,
  userId: string,
  userKeyRecoveryWrapped: string,
): Uint8Array {
  return openKey(recoveryWrapKey, userKeyRecoveryWrapped, aad.recovery(userId));
}

export interface RecoveryFinish {
  request: Pick<
    Schemas["RecoverFinishRequest"],
    "kdf" | "salt" | "auth_key" | "user_key_wrapped" | "recovery"
  >;
  /** Set if a new recovery key was created. */
  recoveryKeyDisplay?: string;
}

/** Body of `POST /v1/auth/recover/finish` without token and device. */
export function buildRecoveryFinish(
  randomness: Randomness,
  input: PasswordChangeInput,
  newRecoveryKey: boolean,
): RecoveryFinish {
  const change = buildPasswordChange(randomness, input, true);
  const password = {
    kdf: change.kdf,
    salt: change.salt,
    auth_key: change.auth_key,
    user_key_wrapped: change.user_key_wrapped,
  };
  if (!newRecoveryKey) return { request: password };
  const recovery = buildRecoveryMaterial(
    randomness,
    input.userId,
    input.userKey,
  );
  return {
    request: { ...password, recovery: recovery.request },
    recoveryKeyDisplay: recovery.recoveryKeyDisplay,
  };
}

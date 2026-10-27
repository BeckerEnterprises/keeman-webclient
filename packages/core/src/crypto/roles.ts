// The owner-signed roles chain of a vault: canonical statements, their
// hash, the commitment to each vault key, signing, and the check of a
// delivered chain from an anchor.
import {
  bytesEqual,
  concatBytes,
  fromBase64Url,
  isJsonObject,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from "./bytes";
import { CryptoError } from "./errors";
import { KEY_BYTES } from "./kdf";
import {
  sign,
  SIGNATURE_BYTES,
  SIGNATURE_CONTEXT,
  verifySignature,
} from "./signing";
import { sodium } from "./sodium";
import { isTimestamp } from "./time";
import { assertUuid, isUuid } from "./uuid";

export interface RoleOwner {
  userId: string;
  /** X25519 public key, Base64url. */
  publicKey: string;
  /** Ed25519 public signing key, Base64url. */
  signingKey: string;
}

export interface RoleStatement {
  vaultId: string;
  version: number;
  /** Hash of the previous statement; `null` for version 1. */
  previous: string | null;
  keyVersion: number;
  keyCommitment: string;
  /** Sorted by `userId`, without duplicates. */
  owners: readonly RoleOwner[];
  signer: string;
  created: string;
}

/** A statement as it travels through the API. */
export interface SignedRoles {
  statement: string;
  signature: string;
}

/** A statement of `GET /v1/vaults/{id}/roles`. */
export interface DeliveredRoles extends SignedRoles {
  version: number;
}

/** Version and hash of a checked statement (box field `roles`, anchors). */
export interface RolePoint {
  version: number;
  hash: string;
}

export interface VerifiedRoles {
  statement: RoleStatement;
  hash: string;
  signed: SignedRoles;
}

function fail(reason: string): never {
  throw new CryptoError("validation", `Invalid roles statement: ${reason}`);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isKey32(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    fromBase64Url(value, KEY_BYTES);
    return true;
  } catch {
    return false;
  }
}

/** Whether a value is a valid `{version, hash}` pair (box field `roles`). */
export function isRolePoint(value: unknown): value is RolePoint {
  return isJsonObject(value) && isCount(value.version) && isKey32(value.hash);
}

function validate(statement: RoleStatement): void {
  if (!isUuid(statement.vaultId)) fail("vault_id");
  if (!isCount(statement.version)) fail("version");
  if (
    statement.version === 1
      ? statement.previous !== null
      : !isKey32(statement.previous)
  )
    fail("previous");
  if (!isCount(statement.keyVersion)) fail("key_version");
  if (!isKey32(statement.keyCommitment)) fail("key_commitment");
  const owners: readonly unknown[] = Array.isArray(statement.owners)
    ? statement.owners
    : [];
  if (owners.length === 0) fail("owners");
  let last = "";
  for (const item of owners) {
    const owner = item as RoleOwner;
    if (!isUuid(owner.userId) || owner.userId <= last) fail("owners order");
    if (!isKey32(owner.publicKey) || !isKey32(owner.signingKey))
      fail("owner keys");
    last = owner.userId;
  }
  if (!isUuid(statement.signer)) fail("signer");
  if (!isTimestamp(statement.created)) fail("created");
}

/**
 * The canonical bytes: ASCII JSON without whitespace in the fixed field
 * order. Every value is a UUID, Base64url, a timestamp or a safe integer,
 * so `JSON.stringify` writes no escapes.
 */
export function encodeRoleStatement(statement: RoleStatement): Uint8Array {
  validate(statement);
  return utf8Encode(
    JSON.stringify({
      v: 1,
      type: "vault_roles",
      vault_id: statement.vaultId,
      version: statement.version,
      previous: statement.previous,
      key_version: statement.keyVersion,
      key_commitment: statement.keyCommitment,
      owners: statement.owners.map((owner) => ({
        user_id: owner.userId,
        public_key: owner.publicKey,
        signing_key: owner.signingKey,
      })),
      signer: statement.signer,
      created: statement.created,
    }),
  );
}

/**
 * Reads statement bytes: every field must be valid and the bytes must be
 * exactly the canonical form, which rules out duplicate keys, other field
 * orders, unknown fields and whitespace.
 */
export function decodeRoleStatement(bytes: Uint8Array): RoleStatement {
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch {
    fail("JSON");
  }
  if (!isJsonObject(value)) fail("not an object");
  if (value.v !== 1 || value.type !== "vault_roles") fail("v or type");
  if (!Array.isArray(value.owners)) fail("owners");
  const owners = (value.owners as unknown[]).map((owner): RoleOwner => {
    if (!isJsonObject(owner)) fail("owner");
    return {
      userId: owner.user_id as string,
      publicKey: owner.public_key as string,
      signingKey: owner.signing_key as string,
    };
  });
  const statement = {
    vaultId: value.vault_id,
    version: value.version,
    previous: value.previous,
    keyVersion: value.key_version,
    keyCommitment: value.key_commitment,
    owners,
    signer: value.signer,
    created: value.created,
  } as RoleStatement;
  if (!bytesEqual(encodeRoleStatement(statement), bytes)) fail("not canonical");
  return statement;
}

function hashWithContext(context: string, bytes: Uint8Array): string {
  return toBase64Url(
    sodium().crypto_generichash(
      32,
      concatBytes(utf8Encode(context), Uint8Array.of(0x00), bytes),
      null,
    ),
  );
}

/** h(S) = BLAKE2b-256("keeman:v1:roles-hash" ‖ 0x00 ‖ bytes). */
export function roleStatementHash(bytes: Uint8Array): string {
  return hashWithContext("keeman:v1:roles-hash", bytes);
}

/** Commitment of a statement to the vault key of its key version. */
export function keyCommitment(
  vaultId: string,
  keyVersion: number,
  vaultKey: Uint8Array,
): string {
  assertUuid(vaultId, "vault_id");
  if (!isCount(keyVersion))
    throw new CryptoError("validation", "Invalid key version");
  if (vaultKey.length !== KEY_BYTES)
    throw new CryptoError("validation", "Vault key must be 32 bytes");
  return hashWithContext(
    `keeman:v1:key-commitment:${vaultId}:${String(keyVersion)}`,
    vaultKey,
  );
}

/** An owner entry from raw public keys. */
export function roleOwner(
  userId: string,
  publicKey: Uint8Array,
  signingKey: Uint8Array,
): RoleOwner {
  if (publicKey.length !== KEY_BYTES || signingKey.length !== KEY_BYTES)
    throw new CryptoError("validation", "Owner keys must be 32 bytes");
  return {
    userId,
    publicKey: toBase64Url(publicKey),
    signingKey: toBase64Url(signingKey),
  };
}

/** Owners sorted by `userId` (string order of the canonical UUIDs). */
export function sortOwners(owners: readonly RoleOwner[]): RoleOwner[] {
  return [...owners].sort((a, b) =>
    a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
  );
}

/**
 * Signs a statement with the signer's secret key. The key must belong to
 * the signing key the statement names for the signer, where it names one.
 */
export function signRoleStatement(
  statement: RoleStatement,
  secretKey: Uint8Array,
): SignedRoles {
  const bytes = encodeRoleStatement(statement);
  const own = statement.owners.find((o) => o.userId === statement.signer);
  if (
    own &&
    !bytesEqual(
      fromBase64Url(own.signingKey, KEY_BYTES),
      secretKey.subarray(SIGNATURE_BYTES - KEY_BYTES),
    )
  )
    throw new CryptoError("validation", "Signing key does not match signer");
  return {
    statement: toBase64Url(bytes),
    signature: toBase64Url(sign(secretKey, SIGNATURE_CONTEXT.roles, bytes)),
  };
}

/** Strict reading of the wire form; the signature is not checked here. */
export function readSignedRoles(signed: SignedRoles): {
  bytes: Uint8Array;
  signature: Uint8Array;
  statement: RoleStatement;
  hash: string;
} {
  const bytes = fromBase64Url(signed.statement);
  const signature = fromBase64Url(signed.signature, SIGNATURE_BYTES);
  const statement = decodeRoleStatement(bytes);
  return { bytes, signature, statement, hash: roleStatementHash(bytes) };
}

export type RoleChainCheck =
  | {
      status: "ok";
      /** Every authenticated statement delivered, ascending. */
      statements: readonly VerifiedRoles[];
      head: VerifiedRoles;
    }
  /** The vault has no chain, and no anchor says otherwise. */
  | { status: "empty" }
  /** The chain ends before the anchor. */
  | { status: "rollback" }
  /** The statement at the anchor's version has another hash. */
  | { status: "fork" }
  /** A statement breaks a rule. */
  | { status: "invalid"; version: number; reason: string };

function verifyBy(
  signer: RoleOwner | undefined,
  item: { bytes: Uint8Array; signature: Uint8Array },
): boolean {
  if (!signer) return false;
  try {
    verifySignature(
      fromBase64Url(signer.signingKey, KEY_BYTES),
      SIGNATURE_CONTEXT.roles,
      item.bytes,
      item.signature,
    );
    return true;
  } catch {
    return false;
  }
}

function stepError(
  prev: RoleStatement & { hash: string },
  next: RoleStatement,
): string | undefined {
  if (next.previous !== prev.hash) return "previous";
  if (
    next.keyVersion === prev.keyVersion
      ? next.keyCommitment !== prev.keyCommitment
      : next.keyVersion !== prev.keyVersion + 1
  )
    return "key_version";
  return undefined;
}

/**
 * Checks a delivered chain. With an anchor, the statement at its version
 * must have its hash; later statements must follow the chain rules, and
 * earlier ones are authenticated through their hash links. Without an
 * anchor the chain must start at version 1 and follow the rules from
 * there; trust in it then comes from elsewhere (an inviter's box, the
 * transition rules).
 */
export function checkRoleChain(input: {
  vaultId: string;
  statements: readonly DeliveredRoles[];
  anchor?: RolePoint | undefined;
}): RoleChainCheck {
  const { anchor, statements: delivered } = input;
  const first = delivered[0];
  if (!first) return anchor ? { status: "rollback" } : { status: "empty" };
  const invalid = (version: number, reason: string): RoleChainCheck => ({
    status: "invalid",
    version,
    reason,
  });
  for (const [i, item] of delivered.entries())
    if (item.version !== first.version + i) return invalid(item.version, "gap");
  const last = first.version + delivered.length - 1;
  if (anchor) {
    if (last < anchor.version) return { status: "rollback" };
    if (first.version > anchor.version)
      return invalid(first.version, "missing anchor statement");
  } else if (first.version !== 1) {
    return invalid(first.version, "missing first statement");
  }
  const read: (ReturnType<typeof readSignedRoles> & { signed: SignedRoles })[] =
    [];
  for (const item of delivered) {
    let entry: ReturnType<typeof readSignedRoles>;
    try {
      entry = readSignedRoles(item);
    } catch {
      return invalid(item.version, "unreadable");
    }
    if (entry.statement.version !== item.version)
      return invalid(item.version, "version");
    if (entry.statement.vaultId !== input.vaultId)
      return invalid(item.version, "vault_id");
    read.push({
      ...entry,
      signed: { statement: item.statement, signature: item.signature },
    });
  }
  const at = (i: number) => {
    const entry = read[i];
    if (!entry) throw new Error("index out of range");
    return entry;
  };
  let start = 0;
  if (anchor) {
    start = anchor.version - first.version;
    if (at(start).hash !== anchor.hash) return { status: "fork" };
    for (let i = start - 1; i >= 0; i--)
      if (at(i).hash !== at(i + 1).statement.previous)
        return invalid(at(i).statement.version, "hash link");
  } else {
    const genesis = at(0);
    const signer = genesis.statement.owners.find(
      (owner) => owner.userId === genesis.statement.signer,
    );
    if (!verifyBy(signer, genesis)) return invalid(1, "signature");
  }
  for (let i = start + 1; i < read.length; i++) {
    const prev = at(i - 1);
    const next = at(i);
    const error = stepError(
      { ...prev.statement, hash: prev.hash },
      next.statement,
    );
    if (error) return invalid(next.statement.version, error);
    const signer = prev.statement.owners.find(
      (owner) => owner.userId === next.statement.signer,
    );
    if (!verifyBy(signer, next))
      return invalid(next.statement.version, "signature");
  }
  const statements = read.map((entry) => ({
    statement: entry.statement,
    hash: entry.hash,
    signed: entry.signed,
  }));
  return { status: "ok", statements, head: at(read.length - 1) };
}

export type GrantRolesRejection =
  /** The box names no statement. */
  | "no_roles"
  /** The named statement is not in the checked chain. */
  | "unknown_statement"
  /** No statement commits to the box's key version. */
  | "no_commitment"
  /** The boxed key is not the committed one. */
  | "commitment_mismatch";

/**
 * Whether a boxed vault key may be accepted: the box names a statement of
 * the checked chain, and the chain commits to exactly this key.
 */
export function checkGrantRoles(input: {
  statements: readonly VerifiedRoles[];
  roles: RolePoint | undefined;
  vaultId: string;
  keyVersion: number;
  vaultKey: Uint8Array;
}): GrantRolesRejection | undefined {
  if (!input.roles) return "no_roles";
  const { version, hash } = input.roles;
  if (
    !input.statements.some(
      (item) => item.statement.version === version && item.hash === hash,
    )
  )
    return "unknown_statement";
  const committing = input.statements.filter(
    (item) => item.statement.keyVersion === input.keyVersion,
  );
  if (committing.length === 0) return "no_commitment";
  const commitment = keyCommitment(
    input.vaultId,
    input.keyVersion,
    input.vaultKey,
  );
  if (committing.some((item) => item.statement.keyCommitment !== commitment))
    return "commitment_mismatch";
  return undefined;
}

/** The first statement of a new chain, signed by its only owner or a co-owner. */
export function genesisStatement(input: {
  vaultId: string;
  owners: readonly RoleOwner[];
  signer: string;
  keyVersion: number;
  vaultKey: Uint8Array;
  created: string;
}): RoleStatement {
  return {
    vaultId: input.vaultId,
    version: 1,
    previous: null,
    keyVersion: input.keyVersion,
    keyCommitment: keyCommitment(
      input.vaultId,
      input.keyVersion,
      input.vaultKey,
    ),
    owners: sortOwners(input.owners),
    signer: input.signer,
    created: input.created,
  };
}

/**
 * The statement after `head`: new owners, and with `rotation` the new key
 * version and its commitment; otherwise the key commitment stays.
 */
export function successorStatement(
  head: VerifiedRoles,
  change: {
    owners: readonly RoleOwner[];
    signer: string;
    created: string;
    rotation?: { keyVersion: number; vaultKey: Uint8Array };
  },
): RoleStatement {
  const { statement } = head;
  return {
    vaultId: statement.vaultId,
    version: statement.version + 1,
    previous: head.hash,
    keyVersion: change.rotation?.keyVersion ?? statement.keyVersion,
    keyCommitment: change.rotation
      ? keyCommitment(
          statement.vaultId,
          change.rotation.keyVersion,
          change.rotation.vaultKey,
        )
      : statement.keyCommitment,
    owners: sortOwners(change.owners),
    signer: change.signer,
    created: change.created,
  };
}

import { describe, expect, it } from "vitest";
import { openVaultKeyBox, sealVaultKeyBox } from "../../src/crypto/box";
import {
  fromBase64Url,
  toBase64Url,
  toHex,
  utf8Decode,
  utf8Encode,
} from "../../src/crypto/bytes";
import { fingerprint2Hex, fingerprintHex } from "../../src/crypto/fingerprint";
import { deriveSubkey, KDF_CONTEXT } from "../../src/crypto/kdf";
import { derivePublicKey } from "../../src/crypto/keypair";
import { KeyStore } from "../../src/crypto/keystore";
import {
  checkGrantRoles,
  checkRoleChain,
  decodeRoleStatement,
  encodeRoleStatement,
  genesisStatement,
  isRolePoint,
  keyCommitment,
  readSignedRoles,
  roleOwner,
  roleStatementHash,
  signRoleStatement,
  sortOwners,
  successorStatement,
  type DeliveredRoles,
  type RoleStatement,
  type SignedRoles,
  type VerifiedRoles,
} from "../../src/crypto/roles";
import {
  checkOwnSigningKey,
  deriveSigningKeyPair,
  sign,
  SIGNATURE_CONTEXT,
  signingPublicKeyOf,
  verifySignature,
} from "../../src/crypto/signing";
import { sodium } from "../../src/crypto/sodium";
import {
  CREATED,
  expectCryptoError,
  IDS,
  labelRandomness,
  tv,
} from "../helpers";

const VAULT = IDS.vault;
const A = IDS.user;
const B = IDS.other;
const C = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a70";

function person(userId: string, label: string) {
  const userKey = tv(`roles-${label}-user-key`, 32);
  const signing = deriveSigningKeyPair(userKey);
  const publicKey = derivePublicKey(tv(`roles-${label}-private-key`, 32));
  return {
    userId,
    signing,
    owner: roleOwner(userId, publicKey, signing.publicKey),
  };
}

const alice = person(A, "alice");
const bob = person(B, "bob");
const carol = person(C, "carol");
const key1 = tv("roles-vault-key-1", 32);
const key2 = tv("roles-vault-key-2", 32);

function verified(signed: SignedRoles): VerifiedRoles {
  const read = readSignedRoles(signed);
  return { statement: read.statement, hash: read.hash, signed };
}

function delivered(signed: SignedRoles): DeliveredRoles {
  return { version: verified(signed).statement.version, ...signed };
}

/** S_1 (alice), S_2 (alice promotes bob), S_3 (bob rotates, alice demoted). */
function chain(): SignedRoles[] {
  const s1 = signRoleStatement(
    genesisStatement({
      vaultId: VAULT,
      owners: [alice.owner],
      signer: A,
      keyVersion: 1,
      vaultKey: key1,
      created: CREATED,
    }),
    alice.signing.secretKey,
  );
  const s2 = signRoleStatement(
    successorStatement(verified(s1), {
      owners: [bob.owner, alice.owner],
      signer: A,
      created: CREATED,
    }),
    alice.signing.secretKey,
  );
  const s3 = signRoleStatement(
    successorStatement(verified(s2), {
      owners: [bob.owner],
      signer: B,
      created: CREATED,
      rotation: { keyVersion: 2, vaultKey: key2 },
    }),
    bob.signing.secretKey,
  );
  return [s1, s2, s3];
}

function anchorOf(signed: SignedRoles) {
  const v = verified(signed);
  return { version: v.statement.version, hash: v.hash };
}

/** Re-encodes a statement with arbitrary bytes and signs those bytes. */
function signedBytes(text: string, secretKey: Uint8Array): SignedRoles {
  const bytes = utf8Encode(text);
  return {
    statement: toBase64Url(bytes),
    signature: toBase64Url(sign(secretKey, SIGNATURE_CONTEXT.roles, bytes)),
  };
}

describe("signing key", () => {
  it("is derived from the user key with keemanSG", () => {
    const userKey = tv("roles-alice-user-key", 32);
    const seed = deriveSubkey(userKey, 1, KDF_CONTEXT.signing);
    const pair = sodium().crypto_sign_seed_keypair(seed);
    expect(toHex(signingPublicKeyOf(userKey))).toBe(toHex(pair.publicKey));
    expect(toHex(alice.signing.secretKey)).toBe(toHex(pair.privateKey));
  });

  it("signs with a context and rejects other contexts and changes", () => {
    const message = utf8Encode("statement");
    const signature = sign(
      alice.signing.secretKey,
      SIGNATURE_CONTEXT.roles,
      message,
    );
    verifySignature(
      alice.signing.publicKey,
      SIGNATURE_CONTEXT.roles,
      message,
      signature,
    );
    expectCryptoError(() => {
      verifySignature(
        alice.signing.publicKey,
        "keeman:v1:other" as typeof SIGNATURE_CONTEXT.roles,
        message,
        signature,
      );
    }, "auth");
    expectCryptoError(() => {
      verifySignature(
        bob.signing.publicKey,
        SIGNATURE_CONTEXT.roles,
        message,
        signature,
      );
    }, "auth");
    const flipped = signature.slice();
    flipped[40] = (flipped[40] ?? 0) ^ 1;
    expectCryptoError(() => {
      verifySignature(
        alice.signing.publicKey,
        SIGNATURE_CONTEXT.roles,
        message,
        flipped,
      );
    }, "auth");
    expectCryptoError(() => {
      verifySignature(
        alice.signing.publicKey,
        SIGNATURE_CONTEXT.roles,
        message,
        signature.subarray(0, 63),
      );
    }, "format");
    expectCryptoError(() => {
      verifySignature(
        new Uint8Array(31),
        SIGNATURE_CONTEXT.roles,
        message,
        signature,
      );
    }, "format");
    expectCryptoError(
      () => sign(new Uint8Array(32), SIGNATURE_CONTEXT.roles, message),
      "validation",
    );
  });

  it("compares the own signing key with the server's value", () => {
    const own = alice.signing.publicKey;
    expect(checkOwnSigningKey(own, toBase64Url(own))).toBe("match");
    expect(checkOwnSigningKey(own, null)).toBe("missing");
    expect(checkOwnSigningKey(own, undefined)).toBe("missing");
    expectCryptoError(
      () => checkOwnSigningKey(own, toBase64Url(bob.signing.publicKey)),
      "integrity",
    );
    expectCryptoError(() => checkOwnSigningKey(own, "AAAA"), "integrity");
  });

  it("lives in the key store and is wiped on lock", () => {
    const store = new KeyStore();
    const userKey = tv("roles-alice-user-key", 32).slice();
    store.unlock({
      userId: A,
      userKey,
      privateKey: tv("roles-alice-private-key", 32).slice(),
      publicKey: derivePublicKey(tv("roles-alice-private-key", 32)),
    });
    const scope = store.scope();
    expect(toHex(scope.signingPublicKey())).toBe(
      toHex(alice.signing.publicKey),
    );
    let lent: Uint8Array | undefined;
    scope.useSigningKey((secretKey) => {
      lent = secretKey;
      expect(secretKey).toHaveLength(64);
    });
    store.lock();
    expect(lent?.every((byte) => byte === 0)).toBe(true);
    expectCryptoError(() => store.signingPublicKey(), "locked");
    expectCryptoError(() => scope.useSigningKey(() => 0), "locked");
  });
});

describe("fingerprint v2", () => {
  it("covers both public keys and differs from v1", () => {
    const pk = derivePublicKey(tv("roles-alice-private-key", 32));
    const v2 = fingerprint2Hex(pk, alice.signing.publicKey);
    expect(v2).toMatch(/^[0-9A-F]{64}$/);
    expect(v2).not.toBe(fingerprintHex(pk));
    expect(fingerprint2Hex(pk, bob.signing.publicKey)).not.toBe(v2);
    expectCryptoError(
      () => fingerprint2Hex(pk, new Uint8Array(31)),
      "validation",
    );
  });
});

describe("roles statements", () => {
  const [s1] = chain();

  it("encode canonically and decode back", () => {
    const read = readSignedRoles(s1 as SignedRoles);
    const text = utf8Decode(read.bytes);
    expect(text.startsWith('{"v":1,"type":"vault_roles","vault_id":')).toBe(
      true,
    );
    expect(text).toContain('"previous":null,"key_version":1,');
    expect(encodeRoleStatement(read.statement)).toEqual(read.bytes);
    expect(read.hash).toBe(roleStatementHash(read.bytes));
    expect(read.statement.keyCommitment).toBe(keyCommitment(VAULT, 1, key1));
  });

  it("reject everything but the canonical form", () => {
    const text = utf8Decode(readSignedRoles(s1 as SignedRoles).bytes);
    const variants = [
      text.replace('{"v":1,', '{ "v":1,'),
      text.replace('"v":1,"type":"vault_roles"', '"type":"vault_roles","v":1'),
      text.replace('"v":1,', '"v":1,"v":1,'),
      text.replace('{"v":1,', '{"x":0,"v":1,'),
      text.replace('"version":1', '"version":1.0'),
      text.replace('"v":1', '"v":2'),
      text.replace('"vault_roles"', '"vault_role"'),
      text.replace('"previous":null', '"previous":"x"'),
      text.replace('"version":1', '"version":2'),
      text.replace(/"created":"[^"]+"/, '"created":"yesterday"'),
      text.replace(/"owners":\[.*\]/, '"owners":[]'),
      text.replace(/"owners":/, '"owners":3,"o":'),
      "[]",
      "﻿" + text,
    ];
    for (const variant of variants)
      expectCryptoError(
        () => decodeRoleStatement(utf8Encode(variant)),
        "validation",
      );
    expectCryptoError(
      () => decodeRoleStatement(Uint8Array.of(0xff)),
      "validation",
    );
  });

  it("validate owners, keys and fields when encoding", () => {
    const base = verified(s1 as SignedRoles).statement;
    const broken: RoleStatement[] = [
      { ...base, owners: [alice.owner, alice.owner] },
      { ...base, owners: [bob.owner, alice.owner] },
      { ...base, owners: [{ ...alice.owner, publicKey: "AAAA" }] },
      { ...base, owners: [{ ...alice.owner, userId: "A" }] },
      { ...base, vaultId: "vault" },
      { ...base, version: 0 },
      { ...base, keyVersion: 1.5 },
      { ...base, keyCommitment: "short" },
      { ...base, signer: "x" },
      { ...base, version: 2, previous: null },
    ];
    for (const statement of broken)
      expectCryptoError(() => encodeRoleStatement(statement), "validation");
    expect(sortOwners([bob.owner, alice.owner]).map((o) => o.userId)).toEqual([
      A,
      B,
    ]);
  });

  it("refuse a signing key that does not belong to the signer", () => {
    const statement = verified(s1 as SignedRoles).statement;
    expectCryptoError(
      () => signRoleStatement(statement, bob.signing.secretKey),
      "validation",
    );
  });

  it("checks role points", () => {
    expect(isRolePoint({ version: 1, hash: toBase64Url(key1) })).toBe(true);
    expect(isRolePoint({ version: 0, hash: toBase64Url(key1) })).toBe(false);
    expect(isRolePoint({ version: 1, hash: "x" })).toBe(false);
    expect(isRolePoint(null)).toBe(false);
  });

  it("commit to exactly one key and version", () => {
    const c = keyCommitment(VAULT, 1, key1);
    expect(fromBase64Url(c)).toHaveLength(32);
    expect(keyCommitment(VAULT, 2, key1)).not.toBe(c);
    expect(keyCommitment(IDS.object, 1, key1)).not.toBe(c);
    expect(keyCommitment(VAULT, 1, key2)).not.toBe(c);
    expectCryptoError(() => keyCommitment(VAULT, 0, key1), "validation");
    expectCryptoError(
      () => keyCommitment(VAULT, 1, new Uint8Array(3)),
      "validation",
    );
    expectCryptoError(() => keyCommitment("v", 1, key1), "validation");
  });
});

describe("roles chain", () => {
  const signed = chain();
  const all = signed.map(delivered);

  it("is valid from the first statement and from an anchor", () => {
    const fromStart = checkRoleChain({ vaultId: VAULT, statements: all });
    expect(fromStart.status).toBe("ok");
    if (fromStart.status !== "ok") return;
    expect(fromStart.head.statement.version).toBe(3);
    expect(fromStart.head.statement.owners.map((o) => o.userId)).toEqual([B]);
    for (const anchor of signed.map(anchorOf)) {
      const result = checkRoleChain({
        vaultId: VAULT,
        statements: all,
        anchor,
      });
      expect(result.status).toBe("ok");
    }
    const tail = checkRoleChain({
      vaultId: VAULT,
      statements: all.slice(1),
      anchor: anchorOf(signed[1] as SignedRoles),
    });
    expect(tail.status).toBe("ok");
  });

  it("reports empty chains, rollbacks and forks", () => {
    expect(checkRoleChain({ vaultId: VAULT, statements: [] }).status).toBe(
      "empty",
    );
    const anchor = anchorOf(signed[2] as SignedRoles);
    expect(
      checkRoleChain({ vaultId: VAULT, statements: [], anchor }).status,
    ).toBe("rollback");
    expect(
      checkRoleChain({ vaultId: VAULT, statements: all.slice(0, 2), anchor })
        .status,
    ).toBe("rollback");
    const fork = signRoleStatement(
      successorStatement(verified(signed[1] as SignedRoles), {
        owners: [alice.owner, bob.owner, carol.owner],
        signer: A,
        created: CREATED,
      }),
      alice.signing.secretKey,
    );
    expect(
      checkRoleChain({
        vaultId: VAULT,
        statements: [...all.slice(0, 2), delivered(fork)],
        anchor,
      }).status,
    ).toBe("fork");
  });

  it("rejects broken rules", () => {
    const [s1, s2] = signed as [SignedRoles, SignedRoles, SignedRoles];
    const v1 = verified(s1);
    const v2 = verified(s2);
    const invalid = (statements: DeliveredRoles[], anchor?: SignedRoles) => {
      const result = checkRoleChain({
        vaultId: VAULT,
        statements,
        anchor: anchor ? anchorOf(anchor) : undefined,
      });
      expect(result.status).toBe("invalid");
    };
    // The next signer is not an owner of the previous statement.
    invalid([
      delivered(s1),
      delivered(
        signRoleStatement(
          successorStatement(v1, {
            owners: [bob.owner],
            signer: B,
            created: CREATED,
          }),
          bob.signing.secretKey,
        ),
      ),
    ]);
    // Signed with a key other than the one the previous statement names.
    const other = person(A, "mallory");
    invalid([
      delivered(s1),
      delivered(
        signRoleStatement(
          successorStatement(v1, {
            owners: [other.owner],
            signer: A,
            created: CREATED,
          }),
          other.signing.secretKey,
        ),
      ),
    ]);
    // Broken link, version gap, key version jump, changed commitment.
    const step = (statement: RoleStatement) =>
      delivered(signRoleStatement(statement, alice.signing.secretKey));
    const next = successorStatement(v1, {
      owners: [alice.owner],
      signer: A,
      created: CREATED,
    });
    invalid([delivered(s1), step({ ...next, previous: v2.hash })]);
    invalid([delivered(s1), { ...step({ ...next, version: 3 }), version: 3 }]);
    invalid([delivered(s1), { ...delivered(s2), version: 3 }]);
    invalid([delivered(s1), step({ ...next, keyVersion: 3 })]);
    invalid([
      delivered(s1),
      step({ ...next, keyCommitment: keyCommitment(VAULT, 1, key2) }),
    ]);
    // A genesis that is not self-signed, or starts elsewhere.
    invalid([
      delivered(
        signRoleStatement(
          { ...v1.statement, signer: B },
          bob.signing.secretKey,
        ),
      ),
    ]);
    invalid([delivered(s2)]);
    invalid([delivered(s2)], s1);
    // Another vault, unreadable bytes, a mismatching transport version.
    invalid([
      delivered(
        signRoleStatement(
          { ...v1.statement, vaultId: IDS.object },
          alice.signing.secretKey,
        ),
      ),
    ]);
    invalid([
      {
        version: 1,
        ...signedBytes(
          utf8Decode(readSignedRoles(s1).bytes).replace("{", "{ "),
          alice.signing.secretKey,
        ),
      },
    ]);
    invalid([{ ...delivered(s1), signature: "AAAA" }]);
    invalid([{ ...delivered(s2), version: 1 }]);
    // A statement below the anchor that its successor does not link to.
    const lone = signRoleStatement(
      { ...v1.statement, created: "2026-10-24T08:42:00.000Z" },
      alice.signing.secretKey,
    );
    invalid([delivered(lone), delivered(s2)], s2);
  });

  it("accepts a boxed key only with a matching commitment", () => {
    const result = checkRoleChain({ vaultId: VAULT, statements: all });
    if (result.status !== "ok") throw new Error("chain");
    const point = anchorOf(signed[2] as SignedRoles);
    const grant = (overrides: Partial<Parameters<typeof checkGrantRoles>[0]>) =>
      checkGrantRoles({
        statements: result.statements,
        roles: point,
        vaultId: VAULT,
        keyVersion: 2,
        vaultKey: key2,
        ...overrides,
      });
    expect(grant({})).toBeUndefined();
    expect(grant({ keyVersion: 1, vaultKey: key1 })).toBeUndefined();
    expect(grant({ roles: undefined })).toBe("no_roles");
    expect(grant({ roles: { ...point, hash: toBase64Url(key1) } })).toBe(
      "unknown_statement",
    );
    expect(grant({ roles: { ...point, version: 4 } })).toBe(
      "unknown_statement",
    );
    expect(grant({ keyVersion: 3 })).toBe("no_commitment");
    expect(grant({ vaultKey: key1 })).toBe("commitment_mismatch");
  });
});

describe("key box roles", () => {
  const sender = tv("roles-box-sender", 32);
  const recipient = tv("roles-box-recipient", 32);
  const context = { ownUserId: B, senderId: A, vaultId: VAULT, keyVersion: 2 };
  const point = { version: 3, hash: toBase64Url(key1) };
  const message = {
    vaultId: VAULT,
    keyVersion: 2,
    vaultKey: key2,
    senderId: A,
    recipientId: B,
    vaultName: "Shared",
    created: CREATED,
  };

  it("carries the vouched statement", () => {
    const box = sealVaultKeyBox(
      labelRandomness(),
      sender,
      derivePublicKey(recipient),
      { ...message, roles: point },
    );
    const opened = openVaultKeyBox(
      box,
      recipient,
      derivePublicKey(sender),
      context,
    );
    expect(opened.roles).toEqual(point);
    const old = sealVaultKeyBox(
      labelRandomness(),
      sender,
      derivePublicKey(recipient),
      message,
    );
    expect(
      openVaultKeyBox(old, recipient, derivePublicKey(sender), context).roles,
    ).toBeUndefined();
  });

  it("rejects invalid roles on both sides", () => {
    expectCryptoError(
      () =>
        sealVaultKeyBox(labelRandomness(), sender, derivePublicKey(recipient), {
          ...message,
          roles: { version: 0, hash: point.hash },
        }),
      "validation",
    );
  });
});

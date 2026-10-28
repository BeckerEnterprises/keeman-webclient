// Mandatory tests: the core must pass the binding test vectors in ./data, which
// every KeeMan client passes. A case is either complete or a variation of a
// `base` case (with `override` and `mutations`); ids are unique per file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aad } from "../../src/crypto/aad";
import {
  deriveLoginKeys,
  deriveMasterKey,
  validateKdfParams,
  type KdfParams,
} from "../../src/crypto/argon2";
import {
  openVaultKeyBox,
  sealVaultKeyBox,
  type KeyGrantContext,
} from "../../src/crypto/box";
import {
  fromBase64Url,
  fromHex,
  toBase64Url,
  toHex,
  utf8Decode,
  utf8Encode,
  type JsonObject,
} from "../../src/crypto/bytes";
import {
  openBytes,
  openJson,
  openKey,
  sealJson,
  sealKey,
} from "../../src/crypto/envelope";
import { CryptoError } from "../../src/crypto/errors";
import {
  fingerprint2Hex,
  fingerprintHex,
  formatFingerprint,
} from "../../src/crypto/fingerprint";
import {
  buildPasswordChange,
  buildRecoveryFinish,
  buildRegistration,
  newPasswordSetup,
  startRecovery,
  unlockAccount,
  unwrapRecoveredUserKey,
  type MeKeys,
} from "../../src/crypto/flows/account";
import {
  acceptKeyGrant,
  buildKeyBox,
  buildRotation,
  buildVaultCreation,
  rotateManifest,
  type NewObject,
  type StoredObject,
} from "../../src/crypto/flows/vault";
import { scriptedRandomness } from "../../src/crypto/internal/scripted-randomness";
import {
  deriveAccountKeys,
  deriveRecoveryKeys,
  deriveSubkey,
  prfEvalFirst,
} from "../../src/crypto/kdf";
import { derivePublicKey } from "../../src/crypto/keypair";
import { normalizePassword } from "../../src/crypto/normalize";
import {
  decryptObject,
  encryptObject,
  encryptTombstone,
} from "../../src/crypto/objects";
import { scoped } from "../../src/crypto/random";
import { pad, unpad } from "../../src/crypto/padding";
import {
  formatRecoveryKey,
  parseRecoveryKey,
} from "../../src/crypto/recovery-key";
import {
  checkGrantRoles,
  checkRoleChain,
  decodeRoleStatement,
  encodeRoleStatement,
  keyCommitment,
  readSignedRoles,
  roleStatementHash,
  signRoleStatement,
  successorStatement,
  type RoleOwner,
  type RoleStatement,
  type SignedRoles,
} from "../../src/crypto/roles";
import { decryptBlob } from "../../src/crypto/secretstream";
import {
  decodeFreshness,
  readFreshness,
  signFreshness,
  type FreshnessStatement,
} from "../../src/crypto/freshness";
import {
  decodeConfirmation,
  encodeConfirmationContent,
  readConfirmation,
  signConfirmation,
  validateConfirmationContent,
  type ConfirmationContent,
} from "../../src/crypto/confirmation";
import {
  compareStateCode,
  comparisonPointsStatus,
  formatStateCode,
  parseStateCode,
  stateCodeOf,
  stateCodeUri,
} from "../../src/crypto/state-code";
import {
  deriveSigningKeyPair,
  sign,
  verifySignature,
  type SignatureContext,
} from "../../src/crypto/signing";
import { sodium } from "../../src/crypto/sodium";
import { isUuid, uuidv7 } from "../../src/crypto/uuid";
import {
  checkScheme,
  resolveText,
  resolveUrl,
  type PlaceholderLookup,
} from "../../src/placeholders/resolve";
import { totpAt } from "../../src/totp/code";
import {
  bucketOf,
  checkManifest,
  inspectManifest,
  manifestIds,
  nextRoot,
  nextShards,
  objectHash,
  type CurrentShard,
  type ManifestRead,
  type ManifestRoot,
  type Served,
} from "../../src/model/manifest";

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/restrict-plus-operands,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- untyped JSON fixtures */
type Case = Record<string, any>;

/** Root and shards of stored manifest objects, decrypted and read. */
function openManifest(
  vaultId: string,
  key: Uint8Array,
  objects: readonly StoredObject[],
): {
  root: { raw: JsonObject; seq: number; value: ManifestRoot };
  shards: Map<number, CurrentShard>;
} {
  const ids = manifestIds(vaultId);
  let root: { raw: JsonObject; seq: number; value: ManifestRoot } | undefined;
  const shards = new Map<number, CurrentShard>();
  for (const o of objects) {
    if (o.type !== "manifest" || o.data === null) continue;
    const raw = decryptObject(
      key,
      { vaultId, objectId: o.id, type: "manifest", keyVersion: o.key_version },
      o.data,
    );
    const inspected = inspectManifest(raw, o.id, vaultId);
    if (inspected.status !== "ok") throw new Error("corrupt manifest");
    const value = inspected.value;
    if (value.kind === "root") root = { raw, seq: inspected.seq, value };
    else if (value.kind === "shard")
      shards.set(ids.index.get(o.id) ?? -1, {
        raw,
        seq: inspected.seq,
        objects: value.objects,
      });
  }
  if (!root) throw new Error("no root");
  return { root, shards };
}

const DIR = new URL("./data/", import.meta.url);

function load(name: string): { cases: Case[]; byId: Map<string, Case> } {
  const file = JSON.parse(
    readFileSync(new URL(`${name}.json`, DIR), "utf8"),
  ) as { vectors: string; format_version: number; cases: Case[] };
  expect(file.vectors).toBe(name);
  expect(file.format_version).toBe(1);
  return {
    cases: file.cases,
    byId: new Map(file.cases.map((c) => [c.id as string, c])),
  };
}

function resolve(
  c: Case,
  byId: Map<string, Case>,
): { effective: Case; base: Case | undefined } {
  if (c.base === undefined) return { effective: c, base: undefined };
  const base = byId.get(c.base as string);
  if (!base) throw new Error(`unknown base ${String(c.base)}`);
  return {
    effective: {
      ...structuredClone(base),
      ...structuredClone(c.override ?? {}),
    },
    base,
  };
}

function mutate(input: Uint8Array, mutations: Case[]): Uint8Array {
  let data = Array.from(input);
  for (const m of mutations) {
    const at = (offset: number) => (offset < 0 ? data.length + offset : offset);
    switch (m.op) {
      case "truncate":
        data = data.slice(0, m.length);
        break;
      case "append":
        data.push(
          ...(m.hex === undefined
            ? new Array<number>(m.zeros).fill(0)
            : Array.from(fromHex(m.hex))),
        );
        break;
      case "xor":
        data[at(m.offset)] = (data[at(m.offset)] ?? 0) ^ m.value;
        break;
      case "replace":
        fromHex(m.hex).forEach((byte, i) => (data[at(m.offset) + i] = byte));
        break;
      case "remove":
        data.splice(m.offset, m.length);
        break;
      case "insert":
        data.splice(m.offset, 0, ...Array.from(fromHex(m.hex)));
        break;
      case "swap": {
        const a = data.slice(m.offset_a, m.offset_a + m.length);
        const b = data.slice(m.offset_b, m.offset_b + m.length);
        data.splice(m.offset_a, m.length, ...b);
        data.splice(m.offset_b, m.length, ...a);
        break;
      }
      default:
        throw new Error(`unknown mutation ${String(m.op)}`);
    }
  }
  return Uint8Array.from(data);
}

/** Positive cases run normally; negative ones must fail with the expected code. */
function expectOutcome(c: Case, run: () => void): void {
  const error = c.expected?.error as string | undefined;
  if (error === undefined) {
    run();
    return;
  }
  let caught: unknown;
  try {
    run();
  } catch (e) {
    caught = e;
  }
  expect(caught, `${String(c.id)} should fail with ${error}`).toBeInstanceOf(
    CryptoError,
  );
  expect((caught as CryptoError).code).toBe(error);
}

function buildAad(template: string, p: Case): string {
  switch (template) {
    case "user-key":
      return aad.userKey(p.user_id);
    case "recovery":
      return aad.recovery(p.user_id);
    case "prf":
      return aad.prf(p.user_id, p.credential_id);
    case "private-key":
      return aad.privateKey(p.user_id);
    case "user-data":
      return aad.userData(p.user_id);
    case "vault-key":
      return aad.vaultKey(p.vault_id, p.user_id, p.key_version);
    case "object":
      return aad.object(p.vault_id, p.object_id, p.type, p.key_version);
    case "attachment":
      return aad.attachment(p.attachment_id);
    default:
      throw new Error(`unknown template ${template}`);
  }
}

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const nonceRandomness = (nonceHex: string) =>
  scriptedRandomness({ nonce: fromHex(nonceHex) });
const flowRandomness = (r: Case) =>
  scriptedRandomness(
    Object.fromEntries(
      Object.entries(r.bytes as Record<string, string>).map(([k, v]) => [
        k,
        fromHex(v),
      ]),
    ),
    r.ids ?? {},
  );
const loginKeys = (password: string, salt: Uint8Array, kdf: KdfParams) =>
  deriveLoginKeys(password, salt, kdf);

/** A statement in the field names of the API, as the vectors write it. */
const fromWire = (w: Case): RoleStatement => ({
  vaultId: w.vault_id,
  version: w.version,
  previous: w.previous,
  keyVersion: w.key_version,
  keyCommitment: w.key_commitment,
  owners: (w.owners as Case[]).map((o) => ({
    userId: o.user_id,
    publicKey: o.public_key,
    signingKey: o.signing_key,
  })),
  signer: w.signer,
  created: w.created,
});
const toWire = (st: RoleStatement) => ({
  v: 1,
  type: "vault_roles",
  vault_id: st.vaultId,
  version: st.version,
  previous: st.previous,
  key_version: st.keyVersion,
  key_commitment: st.keyCommitment,
  owners: st.owners.map((o) => ({
    user_id: o.userId,
    public_key: o.publicKey,
    signing_key: o.signingKey,
  })),
  signer: st.signer,
  created: st.created,
});
const ownerOf = (o: Case): RoleOwner => ({
  userId: o.user_id,
  publicKey: toBase64Url(fromHex(o.public_key_hex)),
  signingKey: toBase64Url(fromHex(o.signing_public_key_hex)),
});
const verifiedRoles = (signed: SignedRoles) => {
  const read = readSignedRoles(signed);
  return { statement: read.statement, hash: read.hash, signed };
};

describe("test vectors", () => {
  it("encoding.json", () => {
    for (const c of load("encoding").cases) {
      if (c.kind === "base64url_decode") {
        expectOutcome(c, () => {
          expect(toHex(fromBase64Url(c.text, c.length))).toBe(
            c.expected.bytes_hex,
          );
        });
      } else if (c.kind === "uuid_check") {
        expect(isUuid(c.value), c.id).toBe(c.expected.valid);
      } else {
        expect(uuidv7(fromHex(c.random_hex), c.unix_ms)).toBe(c.expected.uuid);
      }
    }
  });

  it("padding.json", () => {
    for (const c of load("padding").cases) {
      if (c.kind === "pad") {
        expect(toHex(pad(fromHex(c.input_hex)))).toBe(c.expected.padded_hex);
        expect(toHex(unpad(fromHex(c.expected.padded_hex)))).toBe(c.input_hex);
      } else {
        expectOutcome(c, () => unpad(fromHex(c.padded_hex)));
      }
    }
  });

  it("kdf.json", () => {
    for (const c of load("kdf").cases) {
      if (c.kind === "derive") {
        const password = normalizePassword(c.password);
        expect(toHex(password)).toBe(c.password_nfc_utf8_hex);
        const masterKey = deriveMasterKey(password, fromHex(c.salt_hex), c.kdf);
        const keys = deriveAccountKeys(masterKey);
        expect(
          [toHex(masterKey), toHex(keys.authKey), toHex(keys.wrapKey)],
          c.id,
        ).toEqual([
          c.expected.master_key_hex,
          c.expected.auth_key_hex,
          c.expected.wrap_key_hex,
        ]);
      } else if (c.kind === "params") {
        expectOutcome(c, () => validateKdfParams(c.kdf));
      } else {
        expectOutcome(c, () => normalizePassword(c.password));
      }
    }
  });

  it("kdf-subkeys.json", () => {
    for (const c of load("kdf-subkeys").cases) {
      if (c.kind === "subkey") {
        expect(
          toHex(deriveSubkey(fromHex(c.key_hex), c.subkey_id, c.context)),
          c.id,
        ).toBe(c.expected.subkey_hex);
      } else {
        expect(toHex(prfEvalFirst())).toBe(c.expected.hash_hex);
      }
    }
  });

  it("aad.json", () => {
    for (const c of load("aad").cases) {
      expectOutcome(c, () => {
        expect(buildAad(c.template, c.params)).toBe(c.expected.aad);
      });
    }
  });

  it("aead.json", () => {
    const { cases, byId } = load("aead");
    for (const c of cases) {
      const { effective, base } = resolve(c, byId);
      const key = fromHex(effective.key_hex);
      const aadString = buildAad(effective.aad.template, effective.aad.params);
      const open = (envelope: string) =>
        effective.kind === "key"
          ? openKey(key, envelope, aadString)
          : openJson(key, envelope, aadString);
      if (base === undefined && c.envelope_b64 === undefined) {
        expect(aadString).toBe(c.aad.string);
        const plaintext = fromHex(c.plaintext_hex);
        const envelope =
          c.kind === "key"
            ? sealKey(nonceRandomness(c.nonce_hex), key, plaintext, aadString)
            : sealJson(
                nonceRandomness(c.nonce_hex),
                key,
                JSON.parse(c.plaintext_utf8) as JsonObject,
                aadString,
              );
        expect(envelope, c.id).toBe(c.expected.envelope_b64);
        expect(
          toHex(
            c.kind === "key"
              ? openKey(key, envelope, aadString)
              : openBytes(key, envelope, aadString),
          ),
        ).toBe(c.plaintext_hex);
        continue;
      }
      let envelope: string = c.envelope_b64 ?? base?.expected.envelope_b64;
      if (c.mutations)
        envelope = toBase64Url(mutate(fromBase64Url(envelope), c.mutations));
      envelope += c.envelope_b64_suffix ?? "";
      expectOutcome(c, () => open(envelope));
    }
  });

  it("box.json", () => {
    const { cases, byId } = load("box");
    const toContext = (ctx: Case): KeyGrantContext => ({
      ownUserId: ctx.own_user_id,
      senderId: ctx.sender_id,
      vaultId: ctx.vault_id,
      keyVersion: ctx.key_version,
      ...(ctx.current_key_version === undefined
        ? {}
        : { currentKeyVersion: ctx.current_key_version }),
    });
    for (const c of cases) {
      if (c.kind === "keypair") {
        expect(toHex(derivePublicKey(fromHex(c.private_key_hex)))).toBe(
          c.expected.public_key_hex,
        );
        continue;
      }
      const { effective, base } = resolve(c, byId);
      const o = effective.open;
      const openWith = (envelope: string) =>
        openVaultKeyBox(
          envelope,
          fromHex(o.recipient_private_key_hex),
          fromHex(o.sender_public_key_hex),
          toContext(o.context),
        );
      const checkOpened = (opened: ReturnType<typeof openWith>) => {
        expect([
          toHex(opened.vaultKey),
          opened.vaultName,
          opened.created,
          opened.roles,
          opened.manifest,
        ]).toEqual([
          c.expected.vault_key_hex,
          c.expected.vault_name,
          c.expected.created,
          c.expected.roles,
          c.expected.manifest,
        ]);
      };
      if (c.kind === "box" && base === undefined) {
        const m = c.message;
        const envelope = sealVaultKeyBox(
          nonceRandomness(c.nonce_hex),
          fromHex(c.sender_private_key_hex),
          fromHex(c.recipient_public_key_hex),
          {
            vaultId: m.vault_id,
            keyVersion: m.key_version,
            vaultKey: fromBase64Url(m.vault_key),
            senderId: m.sender_id,
            recipientId: m.recipient_id,
            vaultName: m.vault_name,
            created: m.created,
            roles: m.roles,
            manifest: m.manifest,
          },
        );
        expect(envelope, c.id).toBe(c.expected.envelope_b64);
        checkOpened(openWith(envelope));
        continue;
      }
      let envelope: string;
      if (c.kind === "box_open") {
        const body = c.padded
          ? pad(fromHex(c.message_utf8_hex))
          : fromHex(c.message_utf8_hex);
        const nonce = fromHex(c.nonce_hex);
        const raw = sodium().crypto_box_easy(
          body,
          nonce,
          fromHex(c.recipient_public_key_hex),
          fromHex(c.sender_private_key_hex),
        );
        envelope = toBase64Url(Uint8Array.of(2, ...nonce, ...raw));
        expect(envelope).toBe(c.envelope_b64);
      } else {
        envelope = base?.expected.envelope_b64;
        if (c.mutations)
          envelope = toBase64Url(mutate(fromBase64Url(envelope), c.mutations));
      }
      expectOutcome(c, () => {
        const opened = openWith(envelope);
        if (c.expected.error === undefined) checkOpened(opened);
      });
    }
  });

  it("secretstream.json", () => {
    const { cases, byId } = load("secretstream");
    for (const c of cases) {
      const { effective } = resolve(c, byId);
      const ref = effective.blob;
      let blob =
        ref.b64 === undefined
          ? new Uint8Array(readFileSync(new URL(ref.file, DIR)))
          : fromBase64Url(ref.b64);
      expect([blob.length, sha256(blob)]).toEqual([ref.length, ref.sha256_hex]);
      if (c.mutations) blob = mutate(blob, c.mutations);
      expectOutcome(c, () => {
        const plaintext = decryptBlob(
          fromHex(effective.file_key_hex),
          effective.attachment_id,
          blob,
        );
        if (c.expected.error === undefined) {
          expect([plaintext.length, sha256(plaintext)]).toEqual([
            c.expected.plaintext_length,
            c.expected.plaintext_sha256_hex,
          ]);
        }
      });
    }
  });

  it("totp.json", async () => {
    for (const c of load("totp").cases) {
      const code = await totpAt(
        {
          secret: c.secret_base32,
          algorithm: c.algorithm,
          digits: c.digits,
          period: c.period,
        },
        c.unix_time * 1000,
      );
      expect(
        {
          counter: Math.floor(c.unix_time / c.period),
          code: code.code,
          next: code.next,
          valid_until: code.validUntil / 1000,
        },
        c.id,
      ).toEqual(c.expected);
    }
  });

  it("manifest.json", () => {
    const { cases } = load("manifest");
    expect(cases.length).toBeGreaterThan(30);
    for (const c of cases) {
      const e = c.expected;
      switch (c.kind) {
        case "bucket":
          expect(bucketOf(c.object_id), c.id).toBe(e.bucket);
          break;
        case "ids": {
          const ids = manifestIds(c.vault_id);
          expect([ids.root, ids.shards]).toEqual([e.root, e.shards]);
          break;
        }
        case "object_hash":
          expect(
            objectHash(c.vault_id, c.object_id, c.type, c.key_version, c.data),
            c.id,
          ).toBe(e.hash);
          break;
        case "envelope": {
          const key = fromHex(c.key_hex);
          const ref = {
            vaultId: c.vault_id,
            objectId: c.object_id,
            type: "manifest" as const,
            keyVersion: c.key_version,
          };
          const data = encryptObject(
            scriptedRandomness({ nonce: fromHex(c.nonce_hex) }),
            key,
            ref,
            c.content,
          );
          expect(data, c.id).toBe(e.data);
          const inspected = inspectManifest(
            decryptObject(key, ref, data),
            c.object_id,
            c.vault_id,
          );
          const read =
            inspected.status === "corrupt"
              ? { error: "validation" }
              : inspected.value.kind === "newer"
                ? { kind: "newer" }
                : inspected.value.kind === "root"
                  ? {
                      kind: "root",
                      seq: inspected.seq,
                      shards: inspected.value.shards,
                    }
                  : {
                      kind: "shard",
                      seq: inspected.seq,
                      index: inspected.value.index,
                      objects: Object.fromEntries(inspected.value.objects),
                    };
          expect(read, c.id).toEqual(e.read);
          break;
        }
        case "check": {
          const input = c.input;
          const served = new Map<string, Served>(
            (input.served as Case[]).map((s) => [
              s.id,
              {
                type: s.type,
                revision: 1,
                hash: s.hash,
                bucket: bucketOf(s.id),
              },
            ]),
          );
          const read = (id: string): ManifestRead => {
            const r = input.reads[id];
            if (!r) return { kind: "absent" };
            if (r.kind !== "ok") return r as ManifestRead;
            const inspected = inspectManifest(r.content, id, input.vault_id);
            if (inspected.status === "corrupt")
              return { kind: "corrupt", reason: inspected.reason };
            if (inspected.value.kind === "newer") return { kind: "newer" };
            return {
              kind: "ok",
              seq: r.seq,
              raw: r.content,
              value: inspected.value,
            };
          };
          const result = checkManifest({
            vaultId: input.vault_id,
            served,
            read,
            flagged: input.flagged,
            floor: input.floor,
          });
          expect(
            {
              status: result.status,
              issues: result.issues,
              ...(result.rootHash ? { root_hash: result.rootHash } : {}),
            },
            c.id,
          ).toEqual(e);
          break;
        }
        default:
          throw new Error(`unknown kind ${String(c.kind)}`);
      }
    }
  });

  it("placeholders.json", () => {
    for (const c of load("placeholders").cases) {
      const entries = c.entries as Record<string, Case>;
      const lookup: PlaceholderLookup = {
        entry: (id) => {
          const entry = entries[id];
          return entry === undefined
            ? undefined
            : {
                title: entry.title ?? "",
                username: entry.username ?? "",
                password: entry.password ?? "",
                url: entry.url ?? "",
                notes: entry.notes ?? "",
                fields: entry.fields ?? [],
              };
        },
      };
      if (c.kind === "url") {
        const result = resolveUrl(c.entry, lookup);
        const allowed = c.allowed_schemes ?? ["http", "https"];
        expect(
          result.ok
            ? {
                url: result.url,
                display: result.display,
                secret: result.secret,
                warnings: result.warnings,
                open: checkScheme(result.url, allowed) ?? null,
              }
            : { error: result.error, warnings: result.warnings },
          c.id,
        ).toEqual(c.expected);
      } else {
        expect(
          resolveText(c.entry, c.field, lookup, { restricted: c.restricted }),
          c.id,
        ).toEqual(c.expected);
      }
    }
  });

  it("fingerprint.json", () => {
    for (const c of load("fingerprint").cases) {
      const full =
        c.version === 2
          ? fingerprint2Hex(
              fromHex(c.public_key_hex),
              fromHex(c.signing_public_key_hex),
            )
          : fingerprintHex(fromHex(c.public_key_hex));
      expect([full, formatFingerprint(full)]).toEqual([
        c.expected.fingerprint_hex,
        c.expected.display,
      ]);
    }
  });

  it("recovery-key.json", () => {
    for (const c of load("recovery-key").cases) {
      if (c.kind === "format") {
        const rk = fromHex(c.recovery_key_hex);
        const { recoveryAuthKey, recoveryWrapKey } = deriveRecoveryKeys(rk);
        expect([
          formatRecoveryKey(rk),
          toHex(recoveryAuthKey),
          toHex(recoveryWrapKey),
        ]).toEqual([
          c.expected.display,
          c.expected.recovery_auth_key_hex,
          c.expected.recovery_wrap_key_hex,
        ]);
      } else {
        expectOutcome(c, () => {
          expect(toHex(parseRecoveryKey(c.input))).toBe(
            c.expected.recovery_key_hex,
          );
        });
      }
    }
  });

  it("signing.json", () => {
    const { cases, byId } = load("signing");
    for (const c of cases) {
      if (c.kind === "derive") {
        const userKey = fromHex(c.user_key_hex);
        expect([
          toHex(deriveSubkey(userKey, 1, "keemanSG")),
          toHex(deriveSigningKeyPair(userKey).publicKey),
        ]).toEqual([c.expected.seed_hex, c.expected.public_key_hex]);
        continue;
      }
      const { effective, base } = resolve(c, byId);
      let signature: Uint8Array;
      if (base === undefined) {
        const pair = sodium().crypto_sign_seed_keypair(fromHex(c.seed_hex));
        signature = sign(
          pair.privateKey,
          c.context as SignatureContext,
          fromHex(c.message_hex),
        );
        expect(toHex(signature), c.id).toBe(c.expected.signature_hex);
        expect(toHex(pair.publicKey)).toBe(c.public_key_hex);
      } else if (effective.signature_hex !== undefined) {
        // A signature built for the case: small-order R or public key.
        signature = fromHex(effective.signature_hex);
      } else {
        signature = fromHex(base.expected.signature_hex);
        if (c.mutations) signature = mutate(signature, c.mutations);
      }
      expectOutcome(c, () => {
        verifySignature(
          fromHex(effective.public_key_hex),
          effective.context as SignatureContext,
          fromHex(effective.message_hex),
          signature,
        );
      });
    }
  });

  it("roles.json", () => {
    for (const c of load("roles").cases) {
      const e = c.expected;
      switch (c.kind) {
        case "commitment":
          expect(
            keyCommitment(c.vault_id, c.key_version, fromHex(c.vault_key_hex)),
          ).toBe(e.commitment);
          break;
        case "statement": {
          const statement = fromWire(c.statement);
          const bytes = encodeRoleStatement(statement);
          const signed = signRoleStatement(
            statement,
            deriveSigningKeyPair(fromHex(c.signer_user_key_hex)).secretKey,
          );
          expect([
            toBase64Url(bytes),
            roleStatementHash(bytes),
            signed,
          ]).toEqual([
            e.statement,
            e.hash,
            { statement: e.statement, signature: e.signature },
          ]);
          break;
        }
        case "decode":
          expectOutcome(c, () => {
            const statement = decodeRoleStatement(
              fromBase64Url(c.statement_b64),
            );
            expect(toWire(statement)).toEqual(e.statement);
          });
          break;
        case "chain":
        case "grant": {
          const chain = checkRoleChain({
            vaultId: c.vault_id,
            statements: c.statements,
            anchor: c.anchor ?? undefined,
          });
          if (chain.status !== "ok") {
            expect({ status: chain.status }, c.id).toEqual(e);
            break;
          }
          const head = {
            version: chain.head.statement.version,
            hash: chain.head.hash,
          };
          if (c.kind === "chain") {
            expect({ status: "ok", head }, c.id).toEqual(e);
            break;
          }
          const rejection = checkGrantRoles({
            statements: chain.statements,
            roles: c.roles ?? undefined,
            vaultId: c.vault_id,
            keyVersion: c.key_version,
            vaultKey: fromHex(c.vault_key_hex),
          });
          expect(
            rejection === undefined
              ? {
                  status: "ok",
                  anchor: [
                    head.version,
                    head.hash,
                    chain.head.statement.owners.map((o) => o.userId),
                  ],
                }
              : { status: "rejected", reason: rejection },
            c.id,
          ).toEqual(e);
          break;
        }
        default:
          throw new Error(`unknown kind ${String(c.kind)}`);
      }
    }
  });

  it("freshness.json", () => {
    const wire = (s: FreshnessStatement) =>
      s.type === "user_data_freshness"
        ? { v: 1, type: s.type, user_id: s.userId, time: s.time, seq: s.seq }
        : {
            v: 1,
            type: s.type,
            vault_id: s.vaultId,
            user_id: s.userId,
            time: s.time,
            key_version: s.keyVersion,
            manifest: s.manifest && [s.manifest.seq, s.manifest.hash],
            roles: s.roles && [s.roles.version, s.roles.hash],
          };
    for (const c of load("freshness").cases) {
      const e = c.expected;
      switch (c.kind) {
        case "statement": {
          const statement = decodeFreshness(
            fromBase64Url(e.statement as string),
          );
          expect(wire(statement), c.id).toEqual(c.statement);
          const signed = signFreshness(
            statement,
            deriveSigningKeyPair(fromHex(c.signer_user_key_hex)).secretKey,
          );
          expect(signed, c.id).toEqual({
            statement: e.statement,
            signature: e.signature,
          });
          break;
        }
        case "decode":
          expectOutcome(c, () => {
            const statement = decodeFreshness(fromBase64Url(c.statement_b64));
            expect(wire(statement), c.id).toEqual(e.statement);
          });
          break;
        case "verify":
          expectOutcome(c, () => {
            const statement = readFreshness(
              c.attestation,
              fromHex(c.public_key_hex),
            );
            expect(wire(statement), c.id).toEqual(e.statement);
          });
          break;
        default:
          throw new Error(`unknown kind ${String(c.kind)}`);
      }
    }
  });

  it("confirmation.json", () => {
    const { cases } = load("confirmation");
    const wire = (content: ConfirmationContent) =>
      JSON.parse(utf8Decode(encodeConfirmationContent(content))) as unknown;
    for (const c of cases) {
      const e = c.expected;
      switch (c.kind) {
        case "statement": {
          const content = validateConfirmationContent(c.content);
          expect(toHex(encodeConfirmationContent(content)), c.id).toBe(
            c.content_utf8_hex,
          );
          const signed = signConfirmation(
            { userId: c.user_id, nonce: c.nonce, time: c.time, content },
            deriveSigningKeyPair(fromHex(c.signer_user_key_hex)).secretKey,
          );
          expect(signed, c.id).toEqual({
            statement: e.statement,
            signature: e.signature,
          });
          const decoded = decodeConfirmation(fromBase64Url(e.statement));
          expect(decoded, c.id).toEqual({
            userId: e.decoded.user_id,
            nonce: e.decoded.nonce,
            time: e.decoded.time,
            content: e.decoded.content,
          });
          break;
        }
        case "decode":
          expectOutcome(c, () => {
            const s = decodeConfirmation(fromBase64Url(c.statement_b64));
            expect(
              {
                v: 1,
                type: "device_confirmation",
                user_id: s.userId,
                nonce: s.nonce,
                time: s.time,
                content: s.content,
              },
              c.id,
            ).toEqual(e.statement);
          });
          break;
        case "verify":
          expectOutcome(c, () => {
            const read = readConfirmation(c.answer, fromHex(c.public_key_hex), {
              userId: c.expected_user_id,
              nonce: c.expected_nonce,
            });
            expect(
              { time: read.time, content: wire(read.content) },
              c.id,
            ).toEqual({
              time: e.time,
              content: e.content,
            });
          });
          break;
        case "content":
          expectOutcome(c, () => {
            expect(wire(validateConfirmationContent(c.content)), c.id).toEqual(
              e.content,
            );
          });
          break;
        default:
          throw new Error(`unknown kind ${String(c.kind)}`);
      }
    }
  });

  it("state-code.json", () => {
    const { cases } = load("state-code");
    type Wire = { version: number; hash: string };
    const chain = (statements: Wire[]) =>
      statements.map((s) => ({
        statement: { version: s.version },
        hash: s.hash,
      }));
    for (const c of cases) {
      const e = c.expected;
      switch (c.kind) {
        case "code": {
          const code = stateCodeOf(c.hash);
          const point = { version: c.version as number, code };
          expect(
            [code, formatStateCode(point), stateCodeUri(c.vault_id, point)],
            c.id,
          ).toEqual([e.code, e.display, e.uri]);
          break;
        }
        case "parse":
          expectOutcome(c, () => {
            const parsed = parseStateCode(c.input);
            expect(
              {
                version: parsed.version,
                code: parsed.code,
                vault_id: parsed.vaultId,
              },
              c.id,
            ).toEqual(e);
          });
          break;
        case "compare":
          expect(
            compareStateCode({
              vaultId: c.vault_id,
              statements: chain(c.statements),
              entered: {
                version: c.entered.version,
                code: c.entered.code,
                vaultId: c.entered.vault_id,
              },
            }),
            c.id,
          ).toEqual(e);
          break;
        case "points": {
          const status = comparisonPointsStatus(
            chain(c.statements),
            (c.points as [number, string][]).map(([version, code]) => ({
              version,
              code,
            })),
          );
          expect(
            status.status === "ok"
              ? status
              : {
                  status: status.status,
                  point: [status.point.version, status.point.code],
                },
            c.id,
          ).toEqual(e);
          break;
        }
        default:
          throw new Error(`unknown kind ${String(c.kind)}`);
      }
    }
  });

  it("flows.json", () => {
    const { cases, byId } = load("flows");
    for (const c of cases) {
      const { effective } = resolve(c, byId);
      const i = effective.input ?? {};
      const e = c.expected;
      switch (effective.flow) {
        case "register": {
          const rnd = flowRandomness(i.randomness);
          const setup = newPasswordSetup(rnd, i.kdf);
          const keys = loginKeys(i.password, setup.salt, setup.kdf);
          const result = buildRegistration(rnd, {
            ...setup,
            email: i.email,
            loginKeys: keys,
            userData: i.user_data,
          });
          expect(rnd.unused()).toEqual([]);
          expect([toHex(keys.authKey), toHex(keys.wrapKey)]).toEqual([
            e.auth_key_hex,
            e.wrap_key_hex,
          ]);
          expect(result.request).toEqual(e.request);
          expect(result.recoveryKeyDisplay).toBe(e.recovery_key_display);
          break;
        }
        case "unlock": {
          const inputs = { ...i, ...(c.override ?? {}) };
          expectOutcome(c, () => {
            const keys = loginKeys(
              inputs.password,
              fromBase64Url(inputs.salt, 16),
              inputs.kdf,
            );
            const unlocked = unlockAccount(inputs.me as MeKeys, keys.wrapKey);
            if (e.error === undefined) {
              const a = unlocked.account;
              expect([
                toHex(a.userKey),
                toHex(a.privateKey),
                toHex(a.publicKey),
                fingerprintHex(a.publicKey),
              ]).toEqual([
                e.user_key_hex,
                e.private_key_hex,
                e.public_key_hex,
                e.fingerprint_hex,
              ]);
              expect(unlocked.userData).toEqual(e.user_data);
            }
          });
          break;
        }
        case "password_change": {
          const rnd = flowRandomness(i.randomness);
          const setup = newPasswordSetup(rnd, i.kdf);
          const request = buildPasswordChange(
            rnd,
            {
              ...setup,
              userId: i.user_id,
              userKey: fromHex(i.user_key_hex),
              loginKeys: loginKeys(i.new_password, setup.salt, setup.kdf),
            },
            i.revoke_other_sessions,
          );
          expect(request).toEqual(e.request);
          break;
        }
        case "recovery": {
          const start = startRecovery(i.recovery_key_input);
          expect(start.recoveryAuthKey).toBe(e.recovery_auth_key);
          const userKey = unwrapRecoveredUserKey(
            start.recoveryWrapKey,
            i.user_id,
            i.user_key_recovery_wrapped,
          );
          expect(toHex(userKey)).toBe(e.user_key_hex);
          const rnd = flowRandomness(i.randomness);
          const setup = newPasswordSetup(rnd, i.kdf);
          const finish = buildRecoveryFinish(
            rnd,
            {
              ...setup,
              userId: i.user_id,
              userKey,
              loginKeys: loginKeys(i.new_password, setup.salt, setup.kdf),
            },
            true,
          );
          expect(finish.request).toEqual(e.request);
          expect(finish.recoveryKeyDisplay).toBe(e.recovery_key_display);
          break;
        }
        case "create_vault": {
          const rnd = flowRandomness(i.randomness);
          const userKey = fromHex(i.user_key_hex);
          const signing = deriveSigningKeyPair(userKey);
          const vault = buildVaultCreation(rnd, {
            userId: i.user_id,
            userKey,
            objects: i.objects as NewObject[],
            manifest: i.manifest === true,
            ...(i.roles
              ? {
                  roles: {
                    owner: ownerOf({
                      user_id: i.user_id,
                      public_key_hex: i.roles.public_key_hex,
                      signing_public_key_hex: toHex(signing.publicKey),
                    }),
                    signingSecretKey: signing.secretKey,
                    created: i.roles.created,
                  },
                }
              : {}),
          });
          expect(rnd.unused()).toEqual([]);
          expect(toHex(vault.vaultKey)).toBe(e.vault_key_hex);
          expect(vault.request).toEqual(e.request);
          break;
        }
        case "invite_accept": {
          const owner = i.owner;
          const member = i.member;
          const keyBox = buildKeyBox(flowRandomness(i.randomness.invite), {
            senderId: owner.user_id,
            senderPrivateKey: fromHex(owner.private_key_hex),
            recipientId: member.user_id,
            recipientPublicKey: derivePublicKey(
              fromHex(member.private_key_hex),
            ),
            vaultId: i.vault_id,
            keyVersion: i.key_version,
            vaultKey: fromHex(i.vault_key_hex),
            vaultName: i.vault_name,
            created: i.created,
          });
          expect(keyBox).toBe(e.key_box);
          const accepted = acceptKeyGrant(flowRandomness(i.randomness.accept), {
            grant: {
              key_box: keyBox,
              key_version: i.key_version,
              sender_id: owner.user_id,
            },
            vaultId: i.vault_id,
            ownUserId: member.user_id,
            ownPrivateKey: fromHex(member.private_key_hex),
            userKey: fromHex(member.user_key_hex),
            senderPublicKey: derivePublicKey(fromHex(owner.private_key_hex)),
          });
          expect(accepted.request).toEqual(e.accept_request);
          break;
        }
        case "rotation": {
          const rnd = flowRandomness(i.randomness);
          const dropped = (i.drop_object_ids ?? []) as string[];
          const stored = i.objects as StoredObject[];
          const withManifest = "manifest_floor" in i;
          const rotation = buildRotation(
            rnd,
            {
              vaultId: i.vault_id,
              ownerId: i.owner.user_id,
              ownerPrivateKey: fromHex(i.owner.private_key_hex),
              userKey: fromHex(i.owner.user_key_hex),
              vaultName: i.vault_name,
              created: i.created,
              newKeyVersion: i.new_key_version,
              oldVaultKey: (version) =>
                version === i.old_key_version
                  ? fromHex(i.old_vault_key_hex)
                  : undefined,
              objects: withManifest
                ? stored.filter((o) => o.type !== "manifest")
                : stored,
              dropObjectIds: dropped,
              members: (i.members as Case[]).map((m) => ({
                userId: m.user_id,
                publicKey: fromHex(m.public_key_hex),
              })),
              invites: [],
              ...(i.roles
                ? {
                    roles: {
                      head: verifiedRoles(i.roles.head),
                      owners: (i.roles.owners as Case[]).map(ownerOf),
                      signingSecretKey: deriveSigningKeyPair(
                        fromHex(i.owner.user_key_hex),
                      ).secretKey,
                      created: i.roles.created,
                    },
                  }
                : {}),
            },
            i.now as string | undefined,
          );
          if (withManifest) {
            const old = openManifest(
              i.vault_id,
              fromHex(i.old_vault_key_hex),
              stored,
            );
            const renewed = rotateManifest(
              rnd,
              { vaultId: i.vault_id, newKeyVersion: i.new_key_version },
              {
                root: { raw: old.root.raw, seq: old.root.seq },
                shards: old.shards,
                floor: i.manifest_floor,
              },
              rotation.objects.map((o) => ({
                id: o.id,
                type: o.type,
                hash: objectHash(
                  i.vault_id,
                  o.id,
                  o.type,
                  i.new_key_version,
                  o.data,
                ),
              })),
              rotation.vaultKey,
            );
            expect(renewed).toEqual(e.manifest);
          }
          expect(rnd.unused()).toEqual([]);
          expect(toHex(rotation.vaultKey)).toBe(e.vault_key_hex);
          expect(rotation.objects).toEqual(e.objects);
          if ("drop_object_ids" in e.commit) {
            // Released with the field name of that time.
            const { drop_object_ids: legacy, ...commit } = e.commit as Case;
            const { drop_objects: drops, ...rest } = rotation.commit;
            expect(legacy).toEqual([]);
            expect(drops).toEqual([]);
            expect(rest).toEqual(commit);
          } else {
            expect(rotation.commit).toEqual(e.commit);
          }
          break;
        }
        case "manifest_update": {
          const rnd = flowRandomness(i.randomness);
          const key = fromHex(i.vault_key_hex);
          const old = openManifest(
            i.vault_id,
            key,
            i.manifest as StoredObject[],
          );
          const ids = manifestIds(i.vault_id);
          const encrypt = (label: string, objectId: string, raw: JsonObject) =>
            encryptObject(
              scoped(rnd, label),
              key,
              {
                vaultId: i.vault_id,
                objectId,
                type: "manifest",
                keyVersion: i.key_version,
              },
              raw,
            );
          const ops: Case[] = [];
          const written = nextShards(
            old.shards,
            (i.changes as Case[]).map((c) => ({
              id: c.id,
              type: c.type ?? "group",
              hash:
                c.op === "put"
                  ? objectHash(i.vault_id, c.id, c.type, i.key_version, c.data)
                  : undefined,
            })),
          ).map((shard) => {
            const id = ids.shards[shard.index] ?? "";
            const data = encrypt(
              `manifest.shard.${String(shard.index)}`,
              id,
              shard.raw,
            );
            ops.push({
              id,
              type: "manifest",
              key_version: i.key_version,
              data,
            });
            return {
              index: shard.index,
              seq: shard.seq,
              hash: objectHash(i.vault_id, id, "manifest", i.key_version, data),
            };
          });
          const root = nextRoot(old.root, i.floor, written);
          ops.push({
            id: ids.root,
            type: "manifest",
            key_version: i.key_version,
            data: encrypt("manifest.root", ids.root, root.raw),
          });
          expect(rnd.unused()).toEqual([]);
          expect(ops).toEqual(e.ops);
          break;
        }
        case "role_change": {
          const roles = signRoleStatement(
            successorStatement(verifiedRoles(i.head), {
              owners: (i.owners as Case[]).map(ownerOf),
              signer: i.signer.user_id,
              created: i.created,
            }),
            deriveSigningKeyPair(fromHex(i.signer.user_key_hex)).secretKey,
          );
          expect(roles).toEqual(e.roles);
          expect(verifiedRoles(roles).hash).toBe(e.hash);
          expect(verifiedRoles(i.head).statement.vaultId).toBe(i.vault_id);
          break;
        }
        case "tombstone": {
          const ref = {
            vaultId: i.vault_id,
            objectId: i.object_id,
            type: i.type,
            keyVersion: i.key_version,
          };
          expect(
            encryptTombstone(
              flowRandomness(i.randomness),
              fromHex(i.vault_key_hex),
              ref,
              i.tombstone,
            ),
          ).toBe(e.data);
          break;
        }
        default:
          throw new Error(`unknown flow ${String(effective.flow)}`);
      }
    }
    expect(utf8Encode("x")).toHaveLength(1);
  });
});

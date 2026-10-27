/**
 * In-memory stand-in for the account endpoints, enough to drive the Account
 * facade: it stores what the client sends and checks auth keys as plain
 * text (test data only, never real passwords).
 */
import {
  ARGON2_MESSAGE_KIND,
  type Argon2Request,
  type WorkerLike,
} from "../../src/crypto/argon2-worker";
import { createHmac } from "node:crypto";
import {
  concatBytes,
  fromBase64Url,
  toBase64Url,
  utf8Encode,
} from "../../src/crypto/bytes";
import { readFreshness } from "../../src/crypto/freshness";
import { sodium } from "../../src/crypto/sodium";
import { isManifestId, manifestIds } from "../../src/model/manifest";
import { decodeTotpSecret } from "../../src/totp/uri";
import { iconPng } from "../helpers";
import {
  checkRoles,
  newMember,
  sharing,
  type FakeRotation,
  type PublicSharingUser,
} from "./fake-sharing";

interface UserRecord {
  user_id: string;
  email: string;
  kdf: unknown;
  salt: string;
  auth_key: string;
  user_key_wrapped: string;
  public_key: string;
  private_key_wrapped: string;
  /** `null` for an account from before signing keys. */
  signing_public_key: string | null;
  /** The own attestation of user_data. */
  freshness?: { statement: string; signature: string } | undefined;
  recovery: { auth_key: string; user_key_wrapped: string };
  user_data: { revision: number; data: string };
  twoFactor: TwoFactorRecord;
}

/** Second factors of an account; codes as plain text (test data). */
export interface TwoFactorRecord {
  totpSecret: string | undefined;
  totpLastStep: number | undefined;
  backupCodes: { code: string; used: boolean }[];
  passkeys: {
    id: string;
    credentialId: string;
    name: string;
    created: string;
    lastUsed: string | null;
  }[];
}

interface FakeChallenge {
  purpose: "login" | "recovery";
  userId: string;
  device: string | undefined;
  attempts: number;
  expiresAt: number;
  webauthn: string | undefined;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function randomBase32(length: number): string {
  return Array.from(
    sodium().randombytes_buf(length),
    (b) => BASE32[b & 31] ?? "A",
  ).join("");
}

/** The account TOTP code of a time step (RFC 6238, SHA1, 6 digits). */
export function totpCode(secret: string, step: number): string {
  const key = decodeTotpSecret(secret);
  if (!key) throw new Error("bad secret");
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, "0");
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 30_000);
}

/** What a browser would answer to the echoed WebAuthn options of this fake. */
export function echoCredential(
  publicKey: Record<string, unknown>,
  credentialId: string,
): Record<string, unknown> {
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: { clientDataJSON: publicKey.challenge },
  };
}

export interface StoredObject {
  id: string;
  type: string;
  revision: number;
  key_version: number;
  deleted: boolean;
  data: string | null;
  updated_at: string;
  updated_by: string;
}

export interface MemberRecord {
  role: string;
  state: string;
  key_version: number;
  key_wrapped: string | null;
  key_box: string | null;
  sender_id: string | null;
  pending_key: {
    key_box: string;
    key_version: number;
    sender_id: string;
  } | null;
  created: string;
  /** The member's own attestation of this vault; goes with the membership. */
  freshness?: { statement: string; signature: string } | undefined;
}

/** A statement of the roles chain as the server stores it. */
export interface RoleRecord {
  version: number;
  statement: string;
  signature: string;
  hash: string;
}

export interface VaultRecord {
  id: string;
  revision: number;
  key_version: number;
  /** The roles chain, ascending. */
  roles: RoleRecord[];
  horizon: number;
  created: string;
  rotation_required: boolean;
  members: Map<string, MemberRecord>;
  objects: Map<string, StoredObject>;
}

export interface FakeAttachment {
  id: string;
  vaultId: string;
  entryId: string;
  size: number;
  parts: number;
  state: "uploading" | "complete";
  chunks: Map<number, Uint8Array>;
  blob: Uint8Array | undefined;
}

interface SessionRecord {
  id: string;
  userId: string;
  device: string;
  revoked: boolean;
}

export interface RequestLog {
  method: string;
  path: string;
  body: string | undefined;
}

type Hook = (path: string, method: string) => boolean;

let counter = 0;
function randomToken(): string {
  return toBase64Url(sodium().randombytes_buf(32));
}
function newId(): string {
  counter++;
  return `0192b3a4-5c6d-7e8f-9a0b-${counter.toString(16).padStart(12, "0")}`;
}

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type":
        status >= 400 ? "application/problem+json" : "application/json",
    },
  });
}

function problem(status: number, code: string, extra: object = {}): Response {
  return reply(status, {
    title: code,
    status,
    code,
    instance: "urn:uuid:0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
    ...extra,
  });
}

export class FakeServer {
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly invites = new Set<string>();
  readonly log: RequestLog[] = [];
  readonly #access = new Map<string, string>(); // token -> session id
  readonly #reauth = new Map<string, string>(); // token -> session id
  /** Process the request, then lose the response (network error). */
  dropResponse: Hook = () => false;
  /** Like dropResponse, but stays active until replaced. */
  loseResponses: Hook = () => false;
  /** Answer the next request to this path with this status, unprocessed. */
  failures = new Map<
    string,
    { status: number; code: string; extra?: Record<string, unknown> }[]
  >();
  /** Registration without invite codes (`registration = "open"`). */
  openRegistration = false;
  /** Change a `GET /v1/me` response before it is sent. */
  tamperMe: (me: Record<string, unknown>) => void = () => undefined;
  /** Change a `prelogin` answer before it is sent. */
  tamperPrelogin: (answer: { kdf: unknown; salt: string }) => void = () =>
    undefined;
  /** A lying server: logs in with any auth key. */
  acceptAnyAuthKey = false;
  readonly vaults = new Map<string, VaultRecord>();
  /** Stored idempotent answers: user + key → endpoint, body, response. */
  readonly idempotency = new Map<
    string,
    { endpoint: string; body: string; response: Response }
  >();
  /** Change the vault list before it is sent (key rollback tests). */
  tamperVaults: (list: Record<string, unknown>[]) => void = () => undefined;
  /** Change a changes page before it is sent (rollback and corruption tests). */
  tamperChanges: (page: {
    vault_revision: number;
    objects: StoredObject[];
  }) => void = () => undefined;
  pageLimit = 500;
  /** How far the server clock is ahead (TOTP). */
  clockSkewMs = 0;
  /** Op counts of accepted batch requests, in order. */
  batchSizes: number[] = [];
  /** Ops per batch that are not manifest objects. */
  batchContent: number[] = [];
  /** Attachments by ID; `partSize` is fixed per server. */
  readonly attachments = new Map<string, FakeAttachment>();
  partSize = 8 * 1024 * 1024;
  attachmentMaxBytes = 52_428_800;
  /** Open rotations by ID. */
  readonly rotations = new Map<string, FakeRotation>();
  /** Object counts and body sizes of rotation uploads, in order. */
  rotationUploads: { objects: number; bytes: number }[] = [];
  /** The server clock in ms (rotation expiry). */
  now: () => number = () => Date.now();
  /** Runs before each request is handled, e.g. to change the vault meanwhile. */
  onRequest: (method: string, path: string) => void = () => undefined;
  /** Change a lookup or public-key answer before it is sent. */
  tamperLookup: (user: PublicSharingUser) => void = () => undefined;
  tamperPublicKey: (user: PublicSharingUser) => void = () => undefined;
  /** Open login and recovery challenges. */
  faviconEnabled = true;
  /** `features.manifest` of `GET /v1/config`; off like an older server. */
  manifestEnabled = true;
  /** `features.roles`: signing keys and roles chains; off like an older server. */
  rolesEnabled = true;
  /** `features.freshness`: attestations and pairings; off like an older server. */
  freshnessEnabled = true;
  /** Pairings by account. */
  readonly pairings = new Map<string, { payload: string; expiresAt: number }>();
  /** URLs sent to `POST /v1/favicon`. */
  readonly faviconRequests: string[] = [];
  /** The favicon proxy's answer; by default a valid icon. */
  favicon: (url: string) => { status: number; body: Record<string, unknown> } =
    (url) => ({
      status: 200,
      body: {
        mime: "image/png",
        data: toBase64Url(iconPng(42)),
        width: 64,
        height: 64,
        origin: url.replace(/\/$/, ""),
      },
    });
  readonly challenges = new Map<string, FakeChallenge>();
  readonly recoveryTokens = new Map<
    string,
    { userId: string; expiresAt: number }
  >();
  /** Open TOTP setups by session. */
  readonly totpSetups = new Map<
    string,
    { secret: string; attempts: number; expiresAt: number }
  >();
  readonly registrations = new Map<
    string,
    { sessionId: string; name: string; challenge: string; expiresAt: number }
  >();

  readonly fetch = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : undefined;
    const binary = init.body instanceof Uint8Array ? init.body : undefined;
    const headers = new Headers(init.headers);
    this.log.push({ method, path: url.pathname + url.search, body });
    const failure = this.failures.get(url.pathname)?.shift();
    if (failure)
      return Promise.resolve(
        problem(failure.status, failure.code, failure.extra),
      );
    if (init.signal?.aborted) throw init.signal.reason;
    this.onRequest(method, url.pathname);
    const response = this.#handle(
      method,
      url.pathname + url.search,
      body,
      headers,
      binary,
    );
    if (this.loseResponses(url.pathname, method))
      throw new TypeError("network error");
    if (this.dropResponse(url.pathname, method)) {
      this.dropResponse = () => false;
      throw new TypeError("network error");
    }
    return Promise.resolve(response);
  }) as typeof globalThis.fetch;

  userByEmail(email: string): UserRecord | undefined {
    return [...this.users.values()].find((u) => u.email === email);
  }

  requests(path: string): RequestLog[] {
    return this.log.filter((r) => r.path === path);
  }

  expireReauthTokens(): void {
    this.#reauth.clear();
  }

  #session(headers: Headers): SessionRecord | undefined {
    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const session = this.sessions.get(this.#access.get(token) ?? "");
    return session && !session.revoked ? session : undefined;
  }

  #newSession(
    userId: string,
    device: string,
    extra: Record<string, unknown> = {},
  ): Response {
    const session: SessionRecord = {
      id: newId(),
      userId,
      device,
      revoked: false,
    };
    this.sessions.set(session.id, session);
    const token = randomToken();
    this.#access.set(token, session.id);
    return reply(200, {
      status: "ok",
      session_id: session.id,
      user_id: userId,
      access_token: token,
      access_expires_in: 900,
      ...extra,
    });
  }

  /** Turns on TOTP like a finished setup; returns the secret. */
  enableTotp(email: string, backupCodes: string[] = []): string {
    const user = this.userByEmail(email);
    if (!user) throw new Error("no such user");
    const secret = randomBase32(32);
    user.twoFactor.totpSecret = secret;
    user.twoFactor.totpLastStep = undefined;
    user.twoFactor.backupCodes = backupCodes.map((code) => ({
      code,
      used: false,
    }));
    return secret;
  }

  /** The TOTP code of an account, `offset` steps from now. */
  totpNow(email: string, offset = 0): string {
    const secret = this.userByEmail(email)?.twoFactor.totpSecret;
    if (!secret) throw new Error("no TOTP");
    return totpCode(secret, totpStep(this.now()) + offset);
  }

  #hasFactor(user: UserRecord): boolean {
    return (
      user.twoFactor.totpSecret !== undefined ||
      user.twoFactor.passkeys.length > 0
    );
  }

  #challenge(
    user: UserRecord,
    purpose: "login" | "recovery",
    device: string | undefined,
  ): Response {
    const token = randomToken();
    this.challenges.set(token, {
      purpose,
      userId: user.user_id,
      device,
      attempts: 0,
      expiresAt: this.now() + 300_000,
      webauthn: undefined,
    });
    const two = user.twoFactor;
    const methods = [
      ...(two.totpSecret ? ["totp"] : []),
      ...(two.passkeys.length > 0 ? ["webauthn"] : []),
      ...(two.backupCodes.some((c) => !c.used) ? ["backup_code"] : []),
    ];
    return reply(200, {
      status: "second_factor_required",
      challenge_token: token,
      methods,
      expires_in: 300,
    });
  }

  #recoveryPayload(user: UserRecord, remaining?: number): Response {
    for (const [token, entry] of this.recoveryTokens)
      if (entry.userId === user.user_id) this.recoveryTokens.delete(token);
    const token = randomToken();
    this.recoveryTokens.set(token, {
      userId: user.user_id,
      expiresAt: this.now() + 600_000,
    });
    return reply(200, {
      status: "recovery_ok",
      recovery_token: token,
      user_id: user.user_id,
      user_key_recovery_wrapped: user.recovery.user_key_wrapped,
      expires_in: 600,
      ...(remaining === undefined ? {} : { backup_codes_remaining: remaining }),
    });
  }

  /** The step of a matching code among T−1, T, T+1 newer than `last`. */
  #totpStep(secret: string, code: unknown, last?: number): number | undefined {
    const now = totpStep(this.now());
    return [now - 1, now, now + 1].find(
      (step) =>
        (last === undefined || step > last) && totpCode(secret, step) === code,
    );
  }

  /** `2fa/*`, without the lockout. */
  #secondFactor(path: string, data: Record<string, unknown>): Response {
    const token = data.challenge_token as string;
    const challenge = this.challenges.get(token);
    if (!challenge || challenge.expiresAt <= this.now())
      return problem(401, "challenge_invalid");
    const user = this.users.get(challenge.userId);
    if (!user) return problem(401, "challenge_invalid");
    const two = user.twoFactor;
    const fail = () => {
      challenge.attempts++;
      if (challenge.attempts >= 5) this.challenges.delete(token);
      return problem(401, "invalid_second_factor");
    };
    let remaining: number | undefined;
    if (path === "/v1/auth/2fa/totp") {
      const step = two.totpSecret
        ? this.#totpStep(two.totpSecret, data.code, two.totpLastStep)
        : undefined;
      if (step === undefined) return fail();
      two.totpLastStep = step;
    } else if (path === "/v1/auth/2fa/backup-code") {
      const code = (data.code as string).replace(/[ -]/g, "").toUpperCase();
      if (!/^[A-Z2-7]{10}$/.test(code))
        return problem(400, "validation_failed");
      const entry = two.backupCodes.find((c) => !c.used && c.code === code);
      if (!entry) return fail();
      entry.used = true;
      remaining = two.backupCodes.filter((c) => !c.used).length;
    } else if (path === "/v1/auth/2fa/webauthn/options") {
      if (two.passkeys.length === 0)
        return problem(409, "two_factor_state_invalid");
      challenge.webauthn = randomToken();
      return reply(200, {
        public_key: {
          challenge: challenge.webauthn,
          rpId: "localhost",
          userVerification: "required",
          allowCredentials: two.passkeys.map((p) => ({
            type: "public-key",
            id: p.credentialId,
          })),
        },
      });
    } else if (path === "/v1/auth/2fa/webauthn/verify") {
      const credential = data.credential as {
        id?: string;
        response?: { clientDataJSON?: unknown };
      };
      const expected = challenge.webauthn;
      challenge.webauthn = undefined;
      const passkey = two.passkeys.find(
        (p) => p.credentialId === credential.id,
      );
      if (
        !expected ||
        !passkey ||
        credential.response?.clientDataJSON !== expected
      )
        return fail();
      passkey.lastUsed = "2026-10-23T08:00:00.000Z";
    } else return problem(404, "not_found");
    this.challenges.delete(token);
    if (challenge.purpose === "recovery")
      return this.#recoveryPayload(user, remaining);
    return this.#newSession(
      user.user_id,
      challenge.device ?? "device",
      remaining === undefined ? {} : { backup_codes_remaining: remaining },
    );
  }

  #recoverStart(data: Record<string, unknown>): Response {
    const user = this.userByEmail(data.email as string);
    if (!user || user.recovery.auth_key !== data.recovery_auth_key)
      return problem(401, "invalid_credentials");
    if (this.#hasFactor(user))
      return this.#challenge(user, "recovery", undefined);
    return this.#recoveryPayload(user);
  }

  #recoverFinish(data: Record<string, unknown>): Response {
    const token = data.recovery_token as string;
    const entry = this.recoveryTokens.get(token);
    if (!entry || entry.expiresAt <= this.now())
      return problem(401, "challenge_invalid");
    const user = this.users.get(entry.userId);
    if (!user) return problem(401, "challenge_invalid");
    if ((data.kdf as { ops?: number } | undefined)?.ops === 1)
      return problem(422, "kdf_params_invalid");
    this.recoveryTokens.delete(token);
    user.kdf = data.kdf;
    user.salt = data.salt as string;
    user.auth_key = data.auth_key as string;
    user.user_key_wrapped = data.user_key_wrapped as string;
    if (data.recovery !== undefined)
      user.recovery = data.recovery as UserRecord["recovery"];
    for (const [key, challenge] of this.challenges)
      if (challenge.userId === user.user_id) this.challenges.delete(key);
    this.#reauth.clear();
    for (const session of this.sessions.values())
      if (session.userId === user.user_id) session.revoked = true;
    return this.#newSession(
      user.user_id,
      (data.device as { name: string }).name,
    );
  }

  /** `/v1/me/totp…`, `/v1/me/backup-codes`, `/v1/me/webauthn…`. */
  #ownTwoFactor(
    method: string,
    path: string,
    data: Record<string, unknown>,
    headers: Headers,
    user: UserRecord,
    session: SessionRecord,
  ): Response | undefined {
    const two = user.twoFactor;
    const reauthed = this.#reauthed(headers, session);
    const newCodes = () => {
      two.backupCodes = Array.from({ length: 10 }, () => ({
        code: randomBase32(10),
        used: false,
      }));
      return two.backupCodes.map((c) => c.code);
    };
    if (method === "POST" && path === "/v1/me/totp/setup") {
      if (!reauthed) return problem(401, "reauth_required");
      if (two.totpSecret) return problem(409, "two_factor_state_invalid");
      const secret = randomBase32(32);
      this.totpSetups.set(session.id, {
        secret,
        attempts: 0,
        expiresAt: this.now() + 600_000,
      });
      return reply(200, {
        secret,
        otpauth_uri: `otpauth://totp/KeeMan:${encodeURIComponent(user.email)}?secret=${secret}&issuer=KeeMan`,
      });
    }
    if (method === "POST" && path === "/v1/me/totp/enable") {
      const setup = this.totpSetups.get(session.id);
      if (!setup || setup.expiresAt <= this.now())
        return problem(401, "challenge_invalid");
      if (two.totpSecret) return problem(409, "two_factor_state_invalid");
      const step = this.#totpStep(setup.secret, data.code);
      if (step === undefined) {
        setup.attempts++;
        if (setup.attempts >= 5) this.totpSetups.delete(session.id);
        return problem(401, "invalid_second_factor");
      }
      const first = !this.#hasFactor(user);
      this.totpSetups.delete(session.id);
      two.totpSecret = setup.secret;
      two.totpLastStep = step;
      return reply(200, first ? { backup_codes: newCodes() } : {});
    }
    if (method === "DELETE" && path === "/v1/me/totp") {
      if (!reauthed) return problem(401, "reauth_required");
      if (!two.totpSecret) return problem(409, "two_factor_state_invalid");
      two.totpSecret = undefined;
      two.totpLastStep = undefined;
      if (!this.#hasFactor(user)) two.backupCodes = [];
      return reply(204);
    }
    if (method === "POST" && path === "/v1/me/backup-codes") {
      if (!reauthed) return problem(401, "reauth_required");
      if (!this.#hasFactor(user))
        return problem(409, "two_factor_state_invalid");
      return reply(200, { backup_codes: newCodes() });
    }
    if (method === "POST" && path === "/v1/me/webauthn/register/options") {
      if (!reauthed) return problem(401, "reauth_required");
      if (two.passkeys.length >= 10)
        return problem(409, "two_factor_state_invalid");
      const token = randomToken();
      const challenge = randomToken();
      this.registrations.set(token, {
        sessionId: session.id,
        name: data.name as string,
        challenge,
        expiresAt: this.now() + 300_000,
      });
      return reply(200, {
        registration_token: token,
        public_key: {
          challenge,
          rp: { id: "localhost", name: "KeeMan" },
          user: {
            id: toBase64Url(utf8Encode(user.user_id)),
            name: user.email,
            displayName: user.email,
          },
          excludeCredentials: two.passkeys.map((p) => ({
            type: "public-key",
            id: p.credentialId,
          })),
        },
      });
    }
    if (method === "POST" && path === "/v1/me/webauthn/register/verify") {
      const token = data.registration_token as string;
      const registration = this.registrations.get(token);
      if (
        registration?.sessionId !== session.id ||
        registration.expiresAt <= this.now()
      )
        return problem(401, "challenge_invalid");
      this.registrations.delete(token);
      const credential = data.credential as {
        id?: string;
        response?: { clientDataJSON?: unknown };
      };
      if (
        credential.response?.clientDataJSON !== registration.challenge ||
        typeof credential.id !== "string" ||
        [...this.users.values()].some((u) =>
          u.twoFactor.passkeys.some((p) => p.credentialId === credential.id),
        )
      )
        return problem(400, "validation_failed");
      const first = !this.#hasFactor(user);
      const id = newId();
      two.passkeys.push({
        id,
        credentialId: credential.id,
        name: registration.name,
        created: "2026-10-23T08:00:00.000Z",
        lastUsed: null,
      });
      return reply(201, first ? { id, backup_codes: newCodes() } : { id });
    }
    if (method === "GET" && path === "/v1/me/webauthn")
      return reply(200, {
        credentials: two.passkeys.map((p) => ({
          id: p.id,
          name: p.name,
          created: p.created,
          last_used: p.lastUsed,
          prf_enabled: false,
        })),
      });
    if (method === "DELETE" && path.startsWith("/v1/me/webauthn/")) {
      if (!reauthed) return problem(401, "reauth_required");
      const id = path.slice("/v1/me/webauthn/".length);
      const index = two.passkeys.findIndex((p) => p.id === id);
      if (index < 0) return problem(404, "not_found");
      two.passkeys.splice(index, 1);
      if (!this.#hasFactor(user)) two.backupCodes = [];
      return reply(204);
    }
    return undefined;
  }

  #handle(
    method: string,
    path: string,
    body: string | undefined,
    headers: Headers,
    binary?: Uint8Array,
  ): Response {
    const data =
      body === undefined ? {} : (JSON.parse(body) as Record<string, unknown>);
    if (method === "GET" && path === "/v1/time")
      return reply(200, { now_ms: Date.now() + this.clockSkewMs });
    if (method === "GET" && path === "/v1/config")
      return reply(200, {
        server_version: "0.1.0",
        api_version: 1,
        registration: this.openRegistration ? "open" : "invite",
        features: {
          favicon: this.faviconEnabled,
          ...(this.manifestEnabled ? { manifest: true } : {}),
          ...(this.rolesEnabled ? { roles: true } : {}),
          ...(this.freshnessEnabled ? { freshness: true } : {}),
        },
        limits: {
          attachment_max_bytes: this.attachmentMaxBytes,
          batch_max_ops: 500,
        },
      });
    if (method === "POST" && path === "/v1/auth/prelogin") {
      const user = this.userByEmail(data.email as string);
      const answer = {
        kdf: user?.kdf ?? { alg: "argon2id13", ops: 3, mem: 67108864 },
        salt: user?.salt ?? toBase64Url(new Uint8Array(16)),
      };
      this.tamperPrelogin(answer);
      return reply(200, answer);
    }
    if (method === "POST" && path === "/v1/auth/register") {
      const existing = this.users.get(data.user_id as string);
      if (existing?.email === data.email)
        return problem(409, "already_registered");
      if (
        !this.openRegistration &&
        !this.invites.delete(data.invite_code as string)
      )
        return problem(403, "invite_invalid");
      if (this.userByEmail(data.email as string))
        return problem(409, "email_taken");
      const user: UserRecord = {
        user_id: data.user_id as string,
        email: data.email as string,
        kdf: data.kdf,
        salt: data.salt as string,
        auth_key: data.auth_key as string,
        user_key_wrapped: data.user_key_wrapped as string,
        public_key: data.public_key as string,
        private_key_wrapped: data.private_key_wrapped as string,
        signing_public_key:
          typeof data.signing_public_key === "string"
            ? data.signing_public_key
            : null,
        recovery: data.recovery as UserRecord["recovery"],
        user_data: { revision: 1, data: data.user_data as string },
        twoFactor: {
          totpSecret: undefined,
          totpLastStep: undefined,
          backupCodes: [],
          passkeys: [],
        },
      };
      this.users.set(user.user_id, user);
      const created = this.#newSession(
        user.user_id,
        (data.device as { name: string }).name,
      );
      return new Response(created.body, {
        status: 201,
        headers: created.headers,
      });
    }
    if (method === "POST" && path === "/v1/auth/login") {
      const user = this.userByEmail(data.email as string);
      if (!user || (user.auth_key !== data.auth_key && !this.acceptAnyAuthKey))
        return problem(401, "invalid_credentials");
      if (this.#hasFactor(user))
        return this.#challenge(
          user,
          "login",
          (data.device as { name: string }).name,
        );
      return this.#newSession(
        user.user_id,
        (data.device as { name: string }).name,
      );
    }
    if (method === "POST" && path.startsWith("/v1/auth/2fa/"))
      return this.#secondFactor(path, data);
    if (method === "POST" && path === "/v1/auth/recover/start")
      return this.#recoverStart(data);
    if (method === "POST" && path === "/v1/auth/recover/finish")
      return this.#recoverFinish(data);
    const session = this.#session(headers);
    if (!session) return problem(401, "session_invalid");
    const user = this.users.get(session.userId);
    if (!user) return problem(401, "session_invalid");
    const twoFactorResponse = this.#ownTwoFactor(
      method,
      path,
      data,
      headers,
      user,
      session,
    );
    if (twoFactorResponse) return twoFactorResponse;
    const attachmentResponse = this.#attachmentRoute(
      method,
      path,
      data,
      headers,
      binary,
      user,
    );
    if (attachmentResponse) return attachmentResponse;
    const vaultResponse = this.#vaults(
      method,
      path,
      body,
      data,
      headers,
      user,
      session,
    );
    if (vaultResponse) return vaultResponse;
    if (method === "POST" && path === "/v1/auth/logout") {
      session.revoked = true;
      return reply(204);
    }
    if (method === "GET" && path === "/v1/me") {
      const me: Record<string, unknown> = {
        user_id: user.user_id,
        email: user.email,
        kdf: user.kdf,
        salt: user.salt,
        user_key_wrapped: user.user_key_wrapped,
        public_key: user.public_key,
        private_key_wrapped: user.private_key_wrapped,
        ...(this.rolesEnabled
          ? { signing_public_key: user.signing_public_key }
          : {}),
        user_data: { ...user.user_data },
        two_factor: {
          totp: user.twoFactor.totpSecret !== undefined,
          webauthn_credentials: user.twoFactor.passkeys.length,
          backup_codes_remaining: user.twoFactor.backupCodes.filter(
            (c) => !c.used,
          ).length,
        },
        ...(this.freshnessEnabled ? { freshness: user.freshness ?? null } : {}),
        created: "2026-10-23T08:00:00.000Z",
      };
      this.tamperMe(me);
      return reply(200, me);
    }
    if (method === "PUT" && path === "/v1/me/signing-key") {
      if (!this.#reauthed(headers, session))
        return problem(401, "reauth_required");
      const key = data.signing_public_key as string;
      if (user.signing_public_key !== null && user.signing_public_key !== key)
        return problem(409, "conflict");
      user.signing_public_key = key;
      return reply(204);
    }
    if (method === "POST" && path === "/v1/me/reauth") {
      if (data.auth_key !== user.auth_key)
        return problem(401, "invalid_credentials");
      const token = randomToken();
      this.#reauth.set(token, session.id);
      return reply(200, { reauth_token: token, expires_in: 300 });
    }
    if (method === "PUT" && path === "/v1/me/user-data") {
      if (data.expected_revision !== user.user_data.revision)
        return problem(409, "conflict", {
          current_revision: user.user_data.revision,
        });
      user.user_data = {
        revision: user.user_data.revision + 1,
        data: data.data as string,
      };
      return reply(200, { revision: user.user_data.revision });
    }
    if (
      method === "PUT" &&
      (path === "/v1/me/password" || path === "/v1/me/recovery")
    ) {
      if (this.#reauth.get(headers.get("x-keeman-reauth") ?? "") !== session.id)
        return problem(401, "reauth_required");
      if (path === "/v1/me/recovery") {
        user.recovery = data as UserRecord["recovery"];
        return reply(204);
      }
      user.kdf = data.kdf;
      user.salt = data.salt as string;
      user.auth_key = data.auth_key as string;
      user.user_key_wrapped = data.user_key_wrapped as string;
      this.#reauth.clear();
      if (data.revoke_other_sessions === true)
        for (const other of this.sessions.values())
          if (other.userId === user.user_id && other.id !== session.id)
            other.revoked = true;
      return reply(204);
    }
    if (method === "GET" && path === "/v1/me/sessions") {
      return reply(200, {
        sessions: [...this.sessions.values()]
          .filter((s) => s.userId === user.user_id && !s.revoked)
          .map((s) => ({
            id: s.id,
            device_name: s.device,
            client_type: "web",
            created: "2026-10-23T08:00:00.000Z",
            last_seen: "2026-10-23T08:00:00.000Z",
            ip_hint: null,
            current: s.id === session.id,
          })),
      });
    }
    if (method === "DELETE" && path === "/v1/me/sessions?scope=others") {
      for (const other of this.sessions.values())
        if (other.userId === user.user_id && other.id !== session.id)
          other.revoked = true;
      return reply(204);
    }
    if (method === "DELETE" && path.startsWith("/v1/me/sessions/")) {
      const target = this.sessions.get(path.slice("/v1/me/sessions/".length));
      if (target?.userId !== user.user_id || target.revoked)
        return problem(404, "not_found");
      target.revoked = true;
      return reply(204);
    }
    return problem(404, "not_found");
  }

  /**
   * Attestations and pairings like the server: the signature is checked
   * against the caller's signing key, the content is not.
   */
  #freshness(
    method: string,
    path: string,
    data: Record<string, unknown>,
    user: UserRecord,
  ): Response | undefined {
    const vaultMatch = /^\/v1\/vaults\/([^/]+)\/freshness$/.exec(path);
    const mine =
      path === "/v1/me/freshness" ||
      path === "/v1/me/pairing" ||
      vaultMatch !== null;
    if (!mine) return undefined;
    if (!this.freshnessEnabled) return problem(404, "not_found");
    const checked = (type: string, vaultId?: string): Response | undefined => {
      const signed = data.freshness;
      if (user.signing_public_key === null)
        return problem(409, "signing_key_missing");
      try {
        const statement = readFreshness(
          signed,
          fromBase64Url(user.signing_public_key, 32),
        );
        if (
          statement.type !== type ||
          statement.userId !== user.user_id ||
          (statement.type === "vault_freshness" &&
            statement.vaultId !== vaultId)
        )
          return problem(400, "validation_failed");
      } catch {
        return problem(400, "validation_failed");
      }
      return undefined;
    };
    if (vaultMatch) {
      if (method !== "PUT") return problem(405, "method_not_allowed");
      const vaultId = vaultMatch[1] ?? "";
      const member = this.vaults.get(vaultId)?.members.get(user.user_id);
      if (!member) return problem(404, "not_found");
      if (member.state !== "active") return problem(403, "forbidden");
      const rejected = checked("vault_freshness", vaultId);
      if (rejected) return rejected;
      member.freshness = data.freshness as typeof member.freshness;
      return reply(204);
    }
    if (path === "/v1/me/freshness") {
      if (method !== "PUT") return problem(405, "method_not_allowed");
      const rejected = checked("user_data_freshness");
      if (rejected) return rejected;
      user.freshness = data.freshness as typeof user.freshness;
      return reply(204);
    }
    const stored = this.pairings.get(user.user_id);
    if (method === "PUT") {
      const expiresAt = this.now() + 600_000;
      this.pairings.set(user.user_id, {
        payload: data.payload as string,
        expiresAt,
      });
      return reply(200, { expires_at: new Date(expiresAt).toISOString() });
    }
    if (method === "GET") {
      if (!stored || stored.expiresAt <= this.now())
        return problem(404, "not_found");
      return reply(200, {
        payload: stored.payload,
        expires_at: new Date(stored.expiresAt).toISOString(),
      });
    }
    if (method === "DELETE") {
      this.pairings.delete(user.user_id);
      return reply(204);
    }
    return problem(405, "method_not_allowed");
  }

  #reauthed(headers: Headers, session: SessionRecord): boolean {
    return (
      this.#reauth.get(headers.get("x-keeman-reauth") ?? "") === session.id
    );
  }

  /** The attachment endpoints with server semantics. */
  #attachmentRoute(
    method: string,
    path: string,
    data: Record<string, unknown>,
    headers: Headers,
    binary: Uint8Array | undefined,
    user: UserRecord,
  ): Response | undefined {
    const match =
      /^\/v1\/vaults\/([0-9a-f-]{36})\/attachments(?:\/([0-9a-f-]{36})(\/parts\/(\d+)|\/complete|\/transfer)?)?$/.exec(
        path,
      );
    if (!match) return undefined;
    const vaultId = match[1] ?? "";
    const member = (id: string) =>
      this.vaults.get(id)?.members.get(user.user_id)?.state === "active";
    if (!member(vaultId)) return problem(404, "not_found");
    if (match[2] === undefined) {
      if (method !== "POST") return problem(405, "method_not_allowed");
      const id = data.attachment_id as string;
      if (this.attachments.has(id)) return problem(409, "conflict");
      const size = data.size as number;
      const parts = Math.ceil(size / this.partSize);
      this.attachments.set(id, {
        id,
        vaultId,
        entryId: data.entry_id as string,
        size,
        parts,
        state: "uploading",
        chunks: new Map(),
        blob: undefined,
      });
      return reply(201, { part_size: this.partSize, parts });
    }
    const attachment = this.attachments.get(match[2]);
    const action = match[3];
    if (action === "/transfer") {
      const target = data.target_vault_id as string;
      const entry = data.target_entry_id as string;
      if (!attachment) return problem(404, "not_found");
      if (attachment.vaultId !== vaultId)
        return attachment.vaultId === target && attachment.entryId === entry
          ? reply(204)
          : problem(404, "not_found");
      if (!member(target)) return problem(404, "not_found");
      if (attachment.state !== "complete") return problem(409, "conflict");
      attachment.vaultId = target;
      attachment.entryId = entry;
      return reply(204);
    }
    if (attachment?.vaultId !== vaultId) return problem(404, "not_found");
    if (action?.startsWith("/parts/")) {
      if (headers.get("content-type") !== "application/octet-stream" || !binary)
        return problem(415, "unsupported_media_type");
      if (attachment.state === "complete") return problem(409, "conflict");
      const part = Number(match[4]);
      const expected =
        part + 1 < attachment.parts
          ? this.partSize
          : attachment.size - this.partSize * (attachment.parts - 1);
      if (part >= attachment.parts || binary.length !== expected)
        return problem(400, "validation_failed");
      attachment.chunks.set(part, binary.slice());
      return reply(204);
    }
    if (action === "/complete") {
      if (attachment.state === "complete") return reply(204);
      const chunks = Array.from({ length: attachment.parts }, (_, i) =>
        attachment.chunks.get(i),
      );
      if (chunks.some((c) => c === undefined))
        return problem(422, "attachment_incomplete");
      attachment.blob = concatBytes(...(chunks as Uint8Array[]));
      attachment.state = "complete";
      attachment.chunks.clear();
      return reply(204);
    }
    if (method === "DELETE") {
      this.attachments.delete(attachment.id);
      return reply(204);
    }
    if (method === "GET") {
      if (!attachment.blob) return problem(404, "not_found");
      return new Response(attachment.blob.slice(), {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(attachment.blob.length),
        },
      });
    }
    return problem(405, "method_not_allowed");
  }

  /** Attachments of entries a batch deleted, like the server. */
  #dropAttachments(vaultId: string, entryIds?: ReadonlySet<string>): void {
    for (const [id, a] of this.attachments)
      if (a.vaultId === vaultId && (!entryIds || entryIds.has(a.entryId)))
        this.attachments.delete(id);
  }

  /** The vault endpoints with server semantics. */
  #vaults(
    method: string,
    path: string,
    body: string | undefined,
    data: Record<string, unknown>,
    headers: Headers,
    user: UserRecord,
    session: SessionRecord,
  ): Response | undefined {
    const now = "2026-10-23T08:00:00.000Z";
    if (method === "DELETE" && path === "/v1/me") {
      if (!this.#reauthed(headers, session))
        return problem(401, "reauth_required");
      for (const vault of this.vaults.values()) {
        const own = vault.members.get(user.user_id);
        const owners = [...vault.members.entries()].filter(
          ([id, m]) =>
            id !== user.user_id && m.role === "owner" && m.state === "active",
        );
        if (own?.role === "owner" && vault.roles.length > 0 && owners.length)
          return problem(409, "owner_must_demote");
      }
      for (const [id, vault] of this.vaults)
        if (vault.members.has(user.user_id)) this.vaults.delete(id);
      this.users.delete(user.user_id);
      for (const s of this.sessions.values())
        if (s.userId === user.user_id) s.revoked = true;
      return reply(204);
    }
    const freshnessResponse = this.#freshness(method, path, data, user);
    if (freshnessResponse) return freshnessResponse;
    if (method === "GET" && path === "/v1/vaults") {
      const list = [...this.vaults.values()]
        .filter((v) => v.members.has(user.user_id))
        .map((v) => {
          const m = v.members.get(user.user_id);
          const pending = m?.state === "pending";
          return {
            vault_id: v.id,
            role: m?.role,
            state: m?.state,
            vault_key_version: v.key_version,
            member_key_version: m?.key_version ?? v.key_version,
            key_wrapped: pending ? null : (m?.key_wrapped ?? null),
            pending_key: m?.pending_key ?? null,
            invitation:
              pending && m.key_box && m.sender_id
                ? {
                    key_box: m.key_box,
                    key_version: m.key_version,
                    sender_id: m.sender_id,
                  }
                : null,
            revision: v.revision,
            rotation_required: v.rotation_required,
            ...(this.rolesEnabled
              ? { roles_version: v.roles.at(-1)?.version ?? null }
              : {}),
            ...(this.freshnessEnabled
              ? { freshness: m?.freshness ?? null }
              : {}),
            member_count: [...v.members.values()].filter(
              (x) => x.state === "active",
            ).length,
            created: v.created,
          };
        });
      this.tamperVaults(list);
      return reply(200, { vaults: list });
    }
    const idempotent = (endpoint: string, run: () => Response): Response => {
      const key = `${user.user_id}:${headers.get("idempotency-key") ?? ""}`;
      const stored = this.idempotency.get(key);
      if (stored) {
        if (stored.endpoint !== endpoint || stored.body !== body)
          return problem(422, "idempotency_key_reused");
        return stored.response.clone();
      }
      const response = run();
      // Stored at once, like the server does in the same transaction.
      this.idempotency.set(key, {
        endpoint,
        body: body ?? "",
        response: response.clone(),
      });
      return response;
    };
    if (method === "POST" && path === "/v1/vaults") {
      return idempotent("POST /v1/vaults", () => {
        const id = data.vault_id as string;
        if (
          (data.objects as { id: string; type: string }[]).some(
            (o) => (o.type === "manifest") !== isManifestId(id, o.id),
          )
        )
          return problem(400, "validation_failed");
        if (this.vaults.has(id)) return problem(409, "conflict");
        if (this.rolesEnabled && data.roles === undefined)
          return problem(400, "validation_failed");
        if (!this.rolesEnabled && data.roles !== undefined)
          return problem(400, "validation_failed");
        const vault: VaultRecord = {
          id,
          revision: 1,
          key_version: 1,
          roles: [],
          horizon: 0,
          created: now,
          rotation_required: false,
          members: new Map([
            [
              user.user_id,
              newMember("owner", "active", 1, {
                key_wrapped: data.key_wrapped as string,
              }),
            ],
          ]),
          objects: new Map(),
        };
        for (const o of data.objects as {
          id: string;
          type: string;
          key_version: number;
          data: string;
        }[])
          vault.objects.set(o.id, {
            id: o.id,
            type: o.type,
            revision: 1,
            key_version: o.key_version,
            deleted: false,
            data: o.data,
            updated_at: now,
            updated_by: user.user_id,
          });
        if (data.roles !== undefined) {
          if (!user.signing_public_key)
            return problem(409, "signing_key_missing");
          const refused = checkRoles(
            {
              users: () => [...this.users.values()],
              problem,
            },
            vault,
            data.roles as { statement: string; signature: string },
            {
              caller: user.user_id,
              owners: [user.user_id],
              keyVersion: 1,
              keyChange: true,
            },
          );
          if (refused) return refused;
        }
        this.vaults.set(id, vault);
        return reply(201, { revision: 1 });
      });
    }
    if (method === "POST" && path === "/v1/favicon") {
      const url = String(data.url);
      this.faviconRequests.push(url);
      const { status, body } = this.favicon(url);
      return status === 200
        ? reply(200, body)
        : problem(status, String(body.code));
    }
    const shared = sharing(
      {
        vaults: this.vaults,
        users: () => [...this.users.values()],
        rotations: this.rotations,
        now: () => this.now(),
        newId,
        idempotent,
        reply,
        problem,
        tamperLookup: (u) => {
          this.tamperLookup(u);
        },
        tamperPublicKey: (u) => {
          this.tamperPublicKey(u);
        },
        rotationUploads: this.rotationUploads,
        rolesEnabled: () => this.rolesEnabled,
      },
      method,
      path,
      body,
      data,
      user.user_id,
    );
    if (shared) return shared;
    const match =
      /^\/v1\/vaults\/([0-9a-f-]{36})(\/changes|\/batch)?(\?.*)?$/.exec(path);
    if (!match) return undefined;
    const vault = this.vaults.get(match[1] ?? "");
    const member = vault?.members.get(user.user_id);
    if (vault && member && member.state !== "active" && match[2] !== undefined)
      return problem(403, "forbidden");
    if (method === "DELETE" && match[2] === undefined) {
      if (!this.#reauthed(headers, session))
        return problem(401, "reauth_required");
      if (!vault || !member) return problem(404, "not_found");
      if (member.role !== "owner") return problem(403, "forbidden");
      this.vaults.delete(vault.id);
      this.#dropAttachments(vault.id);
      return reply(204);
    }
    if (method === "GET" && match[2] === "/changes") {
      if (!vault || !member) return problem(404, "not_found");
      const query = new URLSearchParams(match[3]?.slice(1) ?? "");
      const since = Number(query.get("since"));
      const limit = Number(query.get("limit") ?? this.pageLimit);
      if (since > 0 && since < vault.horizon)
        return problem(410, "resync_required");
      const [cursorRevision, cursorId] = (
        query.get("cursor") ?? `${String(since)}:`
      ).split(":");
      const after = Number(cursorRevision);
      const sorted = [...vault.objects.values()]
        .filter((o) => o.revision > since && (since > 0 || !o.deleted))
        .filter(
          (o) =>
            o.revision > after ||
            (o.revision === after && o.id > (cursorId ?? "")),
        )
        .sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id));
      const objects = sorted.slice(0, limit).map((o) => ({ ...o }));
      const last = objects.at(-1);
      const page = {
        vault_revision: vault.revision,
        key_version: vault.key_version,
        objects,
        next_cursor:
          sorted.length > limit && last
            ? `${String(last.revision)}:${last.id}`
            : null,
      };
      this.tamperChanges(page);
      return reply(200, page);
    }
    if (method === "POST" && match[2] === "/batch") {
      // Limits of `changes`, checked before anything else like the server does.
      const batchOps = (data.ops ?? []) as { data?: unknown }[];
      if ((body ?? "").length > 16 * 1024 * 1024)
        return problem(413, "payload_too_large");
      if (batchOps.length < 1 || batchOps.length > 500)
        return problem(400, "validation_failed");
      if (
        batchOps.some(
          (op) => typeof op.data === "string" && op.data.length > 1_572_864,
        )
      )
        return problem(413, "payload_too_large");
      this.batchSizes.push(batchOps.length);
      this.batchContent.push(
        (batchOps as { id?: string }[]).filter(
          (op) => !isManifestId(match[1] ?? "", op.id ?? ""),
        ).length,
      );
      return idempotent(`POST ${path}`, () => {
        if (!vault || !member) return problem(404, "not_found");
        const ops = data.ops as {
          op: string;
          id: string;
          type?: string;
          key_version: number;
          expected_revision: number | null;
          data: string;
        }[];
        for (const op of ops) {
          const stored = vault.objects.get(op.id);
          const manifest = isManifestId(vault.id, op.id);
          if (
            op.op === "delete"
              ? manifest
              : (op.type === "manifest") !== manifest
          )
            return problem(400, "validation_failed");
          if (op.op === "put" && stored && stored.type !== op.type)
            return problem(400, "validation_failed");
        }
        if (ops.some((op) => op.key_version !== vault.key_version))
          return problem(409, "stale_key_version", {
            current_key_version: vault.key_version,
          });
        const root = manifestIds(vault.id).root;
        if (
          vault.objects.get(root)?.deleted === false &&
          !ops.some((op) => op.op === "put" && op.id === root)
        )
          return problem(422, "manifest_required");
        const conflicts = ops.flatMap((op) => {
          const stored = vault.objects.get(op.id);
          const entry = (rev: number | null, deleted: boolean) => [
            { id: op.id, current_revision: rev, deleted },
          ];
          if (op.expected_revision === null)
            return stored ? entry(stored.revision, stored.deleted) : [];
          if (!stored) return entry(null, false);
          if (stored.deleted) return entry(stored.revision, true);
          return stored.revision === op.expected_revision
            ? []
            : entry(stored.revision, false);
        });
        if (conflicts.length > 0)
          return problem(409, "conflict", { conflicts });
        vault.revision++;
        for (const op of ops) {
          const stored = vault.objects.get(op.id);
          vault.objects.set(op.id, {
            id: op.id,
            type: op.type ?? stored?.type ?? "entry",
            revision: vault.revision,
            key_version: op.key_version,
            deleted: op.op === "delete",
            data: op.data,
            updated_at: now,
            updated_by: user.user_id,
          });
        }
        this.#dropAttachments(
          vault.id,
          new Set(
            ops
              .filter(
                (op) =>
                  op.op === "delete" &&
                  vault.objects.get(op.id)?.type === "entry",
              )
              .map((op) => op.id),
          ),
        );
        return reply(200, {
          vault_revision: vault.revision,
          results: ops.map((op) => ({ id: op.id, revision: vault.revision })),
        });
      });
    }
    return undefined;
  }
}

/**
 * A worker that answers instantly with keys hashed from password, salt and
 * parameters. The Argon2 derivation itself is covered by the crypto tests; the
 * account flows only need consistent keys.
 */
export function fastWorker(): WorkerLike {
  let listener: ((event: { data?: unknown }) => void) | undefined;
  return {
    postMessage(message) {
      const request = message as Argon2Request;
      const seed = concatBytes(
        request.password,
        request.salt,
        utf8Encode(`${String(request.kdf.ops)}:${String(request.kdf.mem)}`),
      );
      const hash = (label: string) =>
        sodium().crypto_generichash(
          32,
          concatBytes(utf8Encode(label), seed),
          null,
        );
      const data = {
        kind: ARGON2_MESSAGE_KIND,
        id: request.id,
        ok: true,
        authKey: hash("auth"),
        wrapKey: hash("wrap"),
      };
      setTimeout(() => listener?.({ data }), 0);
    },
    addEventListener(type, l) {
      if (type === "message") listener = l;
    },
    terminate() {
      listener = undefined;
    },
  };
}

import * as v from "valibot";
import { ApiError, isProblemCode, NetworkError } from "./errors";
import type { components } from "./openapi.gen";
import {
  AttachmentUploadSchema,
  BackupCodesResponseSchema,
  BatchResultSchema,
  ChangesPageSchema,
  ConfirmationCreatedSchema,
  ConfirmationListSchema,
  ConfirmationStatusSchema,
  type ConfirmationListItem,
  MemberListSchema,
  MeSchema,
  OpenRotationSchema,
  PasskeyListSchema,
  PreloginSchema,
  FaviconSchema,
  PublicUserSchema,
  ReauthSchema,
  RecoveryPayloadSchema,
  RevisionSchema,
  RoleChainSchema,
  SecondFactorSchema,
  ServerConfigSchema,
  SessionListSchema,
  SessionSchema,
  TimeSchema,
  TokenRefreshSchema,
  TotpEnableSchema,
  TotpSetupSchema,
  VaultListSchema,
  WebauthnRegistrationOptionsSchema,
  WebauthnRegistrationSchema,
  WebauthnRequestOptionsSchema,
  type AttachmentUpload,
  type BatchResult,
  type ChangesPage,
  type Me,
  type Member,
  type OpenRotation,
  type PasskeyInfo,
  type Favicon,
  type PublicUser,
  type RoleChain,
  type SecondFactorMethod,
  type ServerConfig,
  type SessionInfo,
  type VaultSummary,
} from "./schemas";

type Schemas = components["schemas"];

export interface AccessToken {
  token: string;
  /** Milliseconds since the epoch, with a safety margin. */
  expiresAt: number;
}

/**
 * Runs refreshes at most once at a time across tabs. The default
 * just calls `perform`; the web app uses Web Locks and a BroadcastChannel and
 * may return a newer token another tab obtained instead of refreshing.
 */
export interface RefreshCoordinator {
  refresh(
    stale: string | undefined,
    perform: () => Promise<AccessToken>,
  ): Promise<AccessToken>;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** `X-Keeman-Client`, e.g. `web/0.1.0`. */
  clientId: string;
  coordinator?: RefreshCoordinator;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** `SecondFactorRequired`. */
export interface SecondFactorChallenge {
  token: string;
  methods: SecondFactorMethod[];
  /** Lifetime in seconds. */
  expiresIn: number;
}

export type LoginOutcome =
  | { kind: "session"; sessionId: string; userId: string }
  | { kind: "second_factor"; challenge: SecondFactorChallenge };

/** `RecoveryPayload`. */
export interface RecoveryPayload {
  recoveryToken: string;
  userId: string;
  userKeyRecoveryWrapped: string;
  /** Lifetime of the recovery token in seconds. */
  expiresIn: number;
}

/** The answer of `2fa/*`: depends on the purpose of the challenge. */
export type SecondFactorOutcome =
  | {
      kind: "session";
      sessionId: string;
      userId: string;
      /** Only after a backup code. */
      backupCodesRemaining: number | undefined;
    }
  | {
      kind: "recovery";
      payload: RecoveryPayload;
      backupCodesRemaining: number | undefined;
    };

export type RecoverStartOutcome =
  | { kind: "recovery"; payload: RecoveryPayload }
  | { kind: "second_factor"; challenge: SecondFactorChallenge };

export interface SessionCreated {
  sessionId: string;
  userId: string;
}

// Upper case: fetch normalises only the standard methods, not PATCH.
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Reading a binary response. */
export interface BytesRun {
  onProgress?: (received: number, total: number | undefined) => void;
  signal?: AbortSignal;
  /** More bytes than this make the answer unusable (`response`, no retry). */
  maxBytes?: number;
}

interface Call {
  method: Method;
  path: string;
  /** A string is JSON, bytes are `application/octet-stream`. */
  body?: string | Uint8Array;
  /** Reads the response as bytes instead of JSON. */
  bytes?: BytesRun;
  /** Cancels the request; its reason is thrown unchanged and never retried. */
  signal?: AbortSignal;
  /** Needs an access token. */
  auth: boolean;
  /** Sends and stores the refresh cookie. */
  cookie?: boolean;
  headers?: Record<string, string>;
  /** Has an `Idempotency-Key`: retried like a GET, with the same bytes. */
  idempotent?: boolean;
  /** One attempt only, e.g. a time measurement. */
  once?: boolean;
  timeoutMs?: number;
}

/** Timeout of `batch` and attachment parts. */
const BATCH_TIMEOUT_MS = 120_000;
/** A download stops after this long without data. */
const IDLE_TIMEOUT_MS = 30_000;
/** `part_size` of v1, for an upload created by a lost request. */
const PART_SIZE = 8 * 1024 * 1024;
const RETRY_DELAYS = [300, 1000];
const SUPERSEDED_RETRY_DELAYS = [300, 1000];
const SUPERSEDED_WINDOW_MS = 20_000;

function vaultPath(vaultId: string): string {
  return `/v1/vaults/${encodeURIComponent(vaultId)}`;
}

function attachmentsPath(vaultId: string): string {
  return `${vaultPath(vaultId)}/attachments`;
}

function attachmentPath(vaultId: string, attachmentId: string): string {
  return `${attachmentsPath(vaultId)}/${encodeURIComponent(attachmentId)}`;
}

/** The body of a response, with progress; `watch` restarts the idle timer. */
async function readBytes(
  response: Response,
  run: BytesRun,
  watch: () => void,
): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  const total =
    Number.isSafeInteger(length) && length >= 0 ? length : undefined;
  const max = run.maxBytes ?? Number.POSITIVE_INFINITY;
  const reader = response.body?.getReader();
  if (total !== undefined && total > max) {
    await reader?.cancel().catch(() => undefined);
    throw new NetworkError("response");
  }
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > max) throw new NetworkError("response");
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > max) {
      await reader.cancel().catch(() => undefined);
      throw new NetworkError("response");
    }
    chunks.push(value);
    watch();
    run.onProgress?.(received, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function challengeOf(
  data: v.InferOutput<typeof SecondFactorSchema>,
): SecondFactorChallenge {
  return {
    token: data.challenge_token,
    methods: data.methods,
    expiresIn: data.expires_in,
  };
}

function payloadOf(
  data: v.InferOutput<typeof RecoveryPayloadSchema>,
): RecoveryPayload {
  return {
    recoveryToken: data.recovery_token,
    userId: data.user_id,
    userKeyRecoveryWrapped: data.user_key_recovery_wrapped,
    expiresIn: data.expires_in,
  };
}

function parse<T>(schema: v.GenericSchema<unknown, T>, data: unknown): T {
  const result = v.safeParse(schema, data);
  if (!result.success) throw new NetworkError("response");
  return result.output;
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const problem =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const retryAfter = /^\d+$/.test(response.headers.get("retry-after") ?? "")
    ? Number(response.headers.get("retry-after"))
    : undefined;
  return new ApiError(
    response.status,
    isProblemCode(problem.code) ? problem.code : "unknown",
    {
      instance:
        typeof problem.instance === "string" &&
        /^urn:uuid:[0-9a-f-]{36}$/.test(problem.instance)
          ? problem.instance
          : undefined,
      retryAfter,
      currentRevision: Number.isSafeInteger(problem.current_revision)
        ? (problem.current_revision as number)
        : undefined,
      currentKeyVersion: Number.isSafeInteger(problem.current_key_version)
        ? (problem.current_key_version as number)
        : undefined,
      currentRolesVersion: Number.isSafeInteger(problem.current_roles_version)
        ? (problem.current_roles_version as number)
        : problem.current_roles_version === null
          ? null
          : undefined,
      conflicts: parseConflicts(problem.conflicts),
    },
  );
}

const ConflictsSchema = v.array(
  v.object({
    id: v.string(),
    current_revision: v.nullable(v.pipe(v.number(), v.safeInteger())),
    deleted: v.boolean(),
  }),
);

function parseConflicts(value: unknown) {
  if (value === undefined) return undefined;
  const result = v.safeParse(ConflictsSchema, value);
  return result.success
    ? result.output.map((c) => ({
        id: c.id,
        currentRevision: c.current_revision,
        deleted: c.deleted,
      }))
    : undefined;
}

/**
 * HTTP client for the KeeMan API. The access token lives only in this
 * object; it is refreshed on demand, never in the background.
 */
export class ApiClient {
  readonly #baseUrl: string;
  readonly #clientId: string;
  readonly #coordinator: RefreshCoordinator;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #timeoutMs: number;
  #access: AccessToken | undefined;
  #refreshing: Promise<AccessToken> | undefined;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#clientId = options.clientId;
    this.#coordinator = options.coordinator ?? {
      refresh: (_stale, perform) => perform(),
    };
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Adopts a token from another tab, or forgets the token (`undefined`). */
  setAccessToken(token: AccessToken | undefined): void {
    this.#access = token;
  }

  get hasAccessToken(): boolean {
    return this.#access !== undefined;
  }

  async config(): Promise<ServerConfig> {
    return parse(
      ServerConfigSchema,
      await this.#request({ method: "GET", path: "/v1/config", auth: false }),
    );
  }

  /** Server time for TOTP; one attempt, so the round trip is real. */
  async time(): Promise<{ now_ms: number }> {
    return parse(
      TimeSchema,
      await this.#request({
        method: "GET",
        path: "/v1/time",
        auth: false,
        once: true,
        timeoutMs: 10_000,
      }),
    );
  }

  async prelogin(email: string): Promise<{ kdf: unknown; salt: string }> {
    return parse(
      PreloginSchema,
      await this.#request({
        method: "POST",
        path: "/v1/auth/prelogin",
        body: JSON.stringify({ email }),
        auth: false,
      }),
    );
  }

  /** `body` is the serialized request, resent unchanged on retries. */
  async register(body: string): Promise<SessionCreated> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/auth/register",
      body,
      auth: false,
      cookie: true,
    });
    return this.#adoptSession(parse(SessionSchema, data));
  }

  async login(body: Schemas["LoginRequest"]): Promise<LoginOutcome> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/auth/login",
      body: JSON.stringify(body),
      auth: false,
      cookie: true,
    });
    if (v.is(SecondFactorSchema, data))
      return { kind: "second_factor", challenge: challengeOf(data) };
    return {
      kind: "session",
      ...this.#adoptSession(parse(SessionSchema, data)),
    };
  }

  // ------------------------------------------------------------ second factor

  /** `2fa/*` are never retried automatically: every failure counts. */
  secondFactorTotp(
    challengeToken: string,
    code: string,
  ): Promise<SecondFactorOutcome> {
    return this.#secondFactor("/v1/auth/2fa/totp", {
      challenge_token: challengeToken,
      code,
    });
  }

  secondFactorBackupCode(
    challengeToken: string,
    code: string,
  ): Promise<SecondFactorOutcome> {
    return this.#secondFactor("/v1/auth/2fa/backup-code", {
      challenge_token: challengeToken,
      code,
    });
  }

  /** `PublicKeyCredentialRequestOptionsJSON` for the passkeys of the account. */
  async secondFactorWebauthnOptions(
    challengeToken: string,
  ): Promise<Record<string, unknown>> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/auth/2fa/webauthn/options",
      body: JSON.stringify({ challenge_token: challengeToken }),
      auth: false,
      cookie: true,
    });
    return parse(WebauthnRequestOptionsSchema, data).public_key;
  }

  /** `credential` is the result of `PublicKeyCredential.toJSON()`. */
  secondFactorWebauthn(
    challengeToken: string,
    credential: unknown,
  ): Promise<SecondFactorOutcome> {
    return this.#secondFactor("/v1/auth/2fa/webauthn/verify", {
      challenge_token: challengeToken,
      credential,
    });
  }

  async #secondFactor(
    path: string,
    body: object,
  ): Promise<SecondFactorOutcome> {
    const data = await this.#request({
      method: "POST",
      path,
      body: JSON.stringify(body),
      auth: false,
      cookie: true,
    });
    if (v.is(RecoveryPayloadSchema, data))
      return {
        kind: "recovery",
        payload: payloadOf(data),
        backupCodesRemaining: data.backup_codes_remaining,
      };
    const session = parse(SessionSchema, data);
    return {
      kind: "session",
      ...this.#adoptSession(session),
      backupCodesRemaining: session.backup_codes_remaining,
    };
  }

  // ------------------------------------------------------------ recovery

  async recoverStart(
    email: string,
    recoveryAuthKey: string,
  ): Promise<RecoverStartOutcome> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/auth/recover/start",
      body: JSON.stringify({ email, recovery_auth_key: recoveryAuthKey }),
      auth: false,
    });
    if (v.is(SecondFactorSchema, data))
      return { kind: "second_factor", challenge: challengeOf(data) };
    return {
      kind: "recovery",
      payload: payloadOf(parse(RecoveryPayloadSchema, data)),
    };
  }

  /** `body` is the serialized request, resent unchanged on retries. */
  async recoverFinish(body: string): Promise<SessionCreated> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/auth/recover/finish",
      body,
      auth: false,
      cookie: true,
    });
    return this.#adoptSession(parse(SessionSchema, data));
  }

  /** Coordinated refresh with the cookie, e.g. at start. */
  async refresh(): Promise<void> {
    await this.#refresh(this.#access?.token);
  }

  /** Revokes the current session; an already invalid session counts as success. */
  async logout(): Promise<void> {
    try {
      await this.#request({
        method: "POST",
        path: "/v1/auth/logout",
        auth: true,
        cookie: true,
      });
    } catch (error) {
      if (!(error instanceof ApiError && error.code === "session_invalid"))
        throw error;
    } finally {
      this.#access = undefined;
    }
  }

  async me(): Promise<Me> {
    return parse(
      MeSchema,
      await this.#request({ method: "GET", path: "/v1/me", auth: true }),
    );
  }

  async reauth(authKey: string): Promise<string> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/me/reauth",
      body: JSON.stringify({ auth_key: authKey }),
      auth: true,
    });
    return parse(ReauthSchema, data).reauth_token;
  }

  async putUserData(expectedRevision: number, data: string): Promise<number> {
    const result = await this.#request({
      method: "PUT",
      path: "/v1/me/user-data",
      body: JSON.stringify({ expected_revision: expectedRevision, data }),
      auth: true,
    });
    return parse(RevisionSchema, result).revision;
  }

  async putPassword(reauthToken: string, body: string): Promise<void> {
    await this.#request({
      method: "PUT",
      path: "/v1/me/password",
      body,
      auth: true,
      headers: { "X-Keeman-Reauth": reauthToken },
    });
  }

  async putRecovery(reauthToken: string, body: string): Promise<void> {
    await this.#request({
      method: "PUT",
      path: "/v1/me/recovery",
      body,
      auth: true,
      headers: { "X-Keeman-Reauth": reauthToken },
    });
  }

  /** Set-once: the same value again answers 204, another one 409. */
  async putSigningKey(reauthToken: string, signingKey: string): Promise<void> {
    await this.#request({
      method: "PUT",
      path: "/v1/me/signing-key",
      body: JSON.stringify({ signing_public_key: signingKey }),
      auth: true,
      idempotent: true,
      headers: { "X-Keeman-Reauth": reauthToken },
    });
  }

  /** Replaces the own attestation of user_data. */
  async putUserDataFreshness(
    freshness: Schemas["SignedFreshness"],
  ): Promise<void> {
    await this.#request({
      method: "PUT",
      path: "/v1/me/freshness",
      body: JSON.stringify({ freshness }),
      auth: true,
      idempotent: true,
    });
  }

  /**
   * Asks the other devices of the account for a confirmation; replaces an
   * open request of this session. A repeat with the same nonce is harmless.
   */
  async requestConfirmation(
    nonce: string,
  ): Promise<{ requestId: string; expiresIn: number }> {
    const data = parse(
      ConfirmationCreatedSchema,
      await this.#request({
        method: "POST",
        path: "/v1/me/confirmations",
        body: JSON.stringify({ nonce }),
        auth: true,
        idempotent: true,
      }),
    );
    return { requestId: data.request_id, expiresIn: data.expires_in };
  }

  /** Open requests of the account, without answers. */
  async confirmations(): Promise<ConfirmationListItem[]> {
    return parse(
      ConfirmationListSchema,
      await this.#request({
        method: "GET",
        path: "/v1/me/confirmations",
        auth: true,
      }),
    ).requests;
  }

  /** The own request with its answer, if any. */
  async confirmation(
    requestId: string,
  ): Promise<{ requestId: string; answer: unknown }> {
    const data = parse(
      ConfirmationStatusSchema,
      await this.#request({
        method: "GET",
        path: `/v1/me/confirmations/${encodeURIComponent(requestId)}`,
        auth: true,
      }),
    );
    return { requestId: data.request_id, answer: data.answer ?? null };
  }

  /** Answers a request of another session; the same bytes may repeat. */
  async answerConfirmation(
    requestId: string,
    answer: Schemas["SignedConfirmation"],
  ): Promise<void> {
    await this.#request({
      method: "PUT",
      path: `/v1/me/confirmations/${encodeURIComponent(requestId)}`,
      body: JSON.stringify({ answer }),
      auth: true,
      idempotent: true,
    });
  }

  async deleteConfirmation(requestId: string): Promise<void> {
    await this.#request({
      method: "DELETE",
      path: `/v1/me/confirmations/${encodeURIComponent(requestId)}`,
      auth: true,
      idempotent: true,
    });
  }

  // ------------------------------------------------------------ own 2FA

  async totpSetup(
    reauthToken: string,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/me/totp/setup",
      auth: true,
      headers: { "X-Keeman-Reauth": reauthToken },
    });
    const setup = parse(TotpSetupSchema, data);
    return { secret: setup.secret, otpauthUri: setup.otpauth_uri };
  }

  /** Backup codes only if TOTP is the first second factor. */
  async totpEnable(code: string): Promise<string[] | undefined> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/me/totp/enable",
      body: JSON.stringify({ code }),
      auth: true,
    });
    return parse(TotpEnableSchema, data).backup_codes;
  }

  async totpDisable(reauthToken: string): Promise<void> {
    await this.#request({
      method: "DELETE",
      path: "/v1/me/totp",
      auth: true,
      headers: { "X-Keeman-Reauth": reauthToken },
    });
  }

  async regenerateBackupCodes(reauthToken: string): Promise<string[]> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/me/backup-codes",
      auth: true,
      headers: { "X-Keeman-Reauth": reauthToken },
    });
    return parse(BackupCodesResponseSchema, data).backup_codes;
  }

  async webauthnRegisterOptions(
    reauthToken: string,
    name: string,
  ): Promise<{
    registrationToken: string;
    publicKey: Record<string, unknown>;
  }> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/me/webauthn/register/options",
      body: JSON.stringify({ name }),
      auth: true,
      headers: { "X-Keeman-Reauth": reauthToken },
    });
    const options = parse(WebauthnRegistrationOptionsSchema, data);
    return {
      registrationToken: options.registration_token,
      publicKey: options.public_key,
    };
  }

  /** `credential` is the result of `PublicKeyCredential.toJSON()`. */
  async webauthnRegisterVerify(
    registrationToken: string,
    credential: unknown,
  ): Promise<{ id: string; backupCodes: string[] | undefined }> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/me/webauthn/register/verify",
      body: JSON.stringify({
        registration_token: registrationToken,
        credential,
      }),
      auth: true,
    });
    const result = parse(WebauthnRegistrationSchema, data);
    return { id: result.id, backupCodes: result.backup_codes };
  }

  async passkeys(): Promise<PasskeyInfo[]> {
    const data = await this.#request({
      method: "GET",
      path: "/v1/me/webauthn",
      auth: true,
    });
    return parse(PasskeyListSchema, data).credentials;
  }

  async deletePasskey(reauthToken: string, id: string): Promise<void> {
    await this.#request({
      method: "DELETE",
      path: `/v1/me/webauthn/${encodeURIComponent(id)}`,
      auth: true,
      headers: { "X-Keeman-Reauth": reauthToken },
    });
  }

  async sessions(): Promise<SessionInfo[]> {
    const data = await this.#request({
      method: "GET",
      path: "/v1/me/sessions",
      auth: true,
    });
    return parse(SessionListSchema, data).sessions;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.#request({
      method: "DELETE",
      path: `/v1/me/sessions/${encodeURIComponent(sessionId)}`,
      auth: true,
    });
  }

  async revokeOtherSessions(): Promise<void> {
    await this.#request({
      method: "DELETE",
      path: "/v1/me/sessions?scope=others",
      auth: true,
    });
  }

  /** Deletes the account; the server clears the cookie. */
  async deleteMe(reauthToken: string): Promise<void> {
    try {
      await this.#request({
        method: "DELETE",
        path: "/v1/me",
        auth: true,
        cookie: true,
        headers: { "X-Keeman-Reauth": reauthToken },
      });
    } finally {
      this.#access = undefined;
    }
  }

  async vaults(): Promise<VaultSummary[]> {
    const data = await this.#request({
      method: "GET",
      path: "/v1/vaults",
      auth: true,
    });
    return parse(VaultListSchema, data).vaults;
  }

  /** `body` and `key` stay the same for every retry. */
  async createVault(key: string, body: string): Promise<number> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/vaults",
      body,
      auth: true,
      idempotent: true,
      headers: { "Idempotency-Key": key },
    });
    return parse(RevisionSchema, data).revision;
  }

  async deleteVault(vaultId: string, reauthToken: string): Promise<void> {
    await this.#request({
      method: "DELETE",
      path: `/v1/vaults/${encodeURIComponent(vaultId)}`,
      auth: true,
      headers: { "X-Keeman-Reauth": reauthToken },
    });
  }

  async changes(
    vaultId: string,
    since: number,
    cursor?: string,
    limit?: number,
  ): Promise<ChangesPage> {
    const query = new URLSearchParams({ since: String(since) });
    if (cursor !== undefined) query.set("cursor", cursor);
    if (limit !== undefined) query.set("limit", String(limit));
    const data = await this.#request({
      method: "GET",
      path: `/v1/vaults/${encodeURIComponent(vaultId)}/changes?${query.toString()}`,
      auth: true,
    });
    return parse(ChangesPageSchema, data);
  }

  async batch(
    vaultId: string,
    key: string,
    body: string,
  ): Promise<BatchResult> {
    const data = await this.#request({
      method: "POST",
      path: `/v1/vaults/${encodeURIComponent(vaultId)}/batch`,
      body,
      auth: true,
      idempotent: true,
      timeoutMs: BATCH_TIMEOUT_MS,
      headers: { "Idempotency-Key": key },
    });
    return parse(BatchResultSchema, data);
  }

  /** `POST /v1/users/lookup`; retried like a read, it changes nothing. */
  async lookupUser(email: string): Promise<PublicUser> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/users/lookup",
      body: JSON.stringify({ email }),
      auth: true,
      idempotent: true,
    });
    return parse(PublicUserSchema, data);
  }

  /** A website's icon through the server's favicon proxy. */
  async favicon(url: string): Promise<Favicon> {
    const data = await this.#request({
      method: "POST",
      path: "/v1/favicon",
      body: JSON.stringify({ url }),
      auth: true,
    });
    return parse(FaviconSchema, data);
  }

  /** Public key of the own account or a co-member. */
  async publicKey(userId: string): Promise<PublicUser> {
    const data = await this.#request({
      method: "GET",
      path: `/v1/users/${encodeURIComponent(userId)}/public-key`,
      auth: true,
    });
    return parse(PublicUserSchema, data);
  }

  async members(vaultId: string): Promise<Member[]> {
    const data = await this.#request({
      method: "GET",
      path: `${vaultPath(vaultId)}/members`,
      auth: true,
    });
    return parse(MemberListSchema, data).members;
  }

  /** Not retried: a repetition answers `409 already_member`. */
  async inviteMember(
    vaultId: string,
    body: Schemas["InviteMemberRequest"],
  ): Promise<void> {
    await this.#request({
      method: "POST",
      path: `${vaultPath(vaultId)}/members`,
      body: JSON.stringify(body),
      auth: true,
    });
  }

  /**
   * Setting the same role again changes nothing, so retries are safe; with
   * a roles chain, `roles` is the next statement.
   */
  async updateMember(
    vaultId: string,
    userId: string,
    role: Schemas["Role"],
    roles?: Schemas["SignedRoles"],
  ): Promise<void> {
    await this.#request({
      method: "PATCH",
      path: `${vaultPath(vaultId)}/members/${encodeURIComponent(userId)}`,
      body: JSON.stringify(roles ? { role, roles } : { role }),
      auth: true,
      idempotent: true,
    });
  }

  /** The roles chain after version `since`. */
  async roles(vaultId: string, since = 0): Promise<RoleChain["statements"]> {
    const data = await this.#request({
      method: "GET",
      path: `${vaultPath(vaultId)}/roles?since=${String(since)}`,
      auth: true,
    });
    return parse(RoleChainSchema, data).statements;
  }

  /**
   * Not retried: a repetition answers `409 roles_conflict`, and the caller
   * finds its statement at the head.
   */
  async appendRoles(
    vaultId: string,
    roles: Schemas["SignedRoles"],
  ): Promise<void> {
    await this.#request({
      method: "POST",
      path: `${vaultPath(vaultId)}/roles`,
      body: JSON.stringify({ roles }),
      auth: true,
    });
  }

  /** Replaces the own attestation of a vault. */
  async putVaultFreshness(
    vaultId: string,
    freshness: Schemas["SignedFreshness"],
  ): Promise<void> {
    await this.#request({
      method: "PUT",
      path: `${vaultPath(vaultId)}/freshness`,
      body: JSON.stringify({ freshness }),
      auth: true,
      idempotent: true,
    });
  }

  async withdrawInvitation(vaultId: string, userId: string): Promise<void> {
    await this.#request({
      method: "DELETE",
      path: `${vaultPath(vaultId)}/members/${encodeURIComponent(userId)}`,
      auth: true,
    });
  }

  async leaveVault(vaultId: string): Promise<void> {
    await this.#request({
      method: "DELETE",
      path: `${vaultPath(vaultId)}/members/me`,
      auth: true,
    });
  }

  async acceptInvitation(
    vaultId: string,
    body: Schemas["VaultKeyAcceptance"],
  ): Promise<void> {
    await this.#request({
      method: "POST",
      path: `${vaultPath(vaultId)}/accept`,
      body: JSON.stringify(body),
      auth: true,
    });
  }

  async declineInvitation(vaultId: string): Promise<void> {
    await this.#request({
      method: "POST",
      path: `${vaultPath(vaultId)}/decline`,
      auth: true,
    });
  }

  /** The pending key after a rotation. */
  async acceptVaultKey(
    vaultId: string,
    body: Schemas["VaultKeyAcceptance"],
  ): Promise<void> {
    await this.#request({
      method: "POST",
      path: `${vaultPath(vaultId)}/key`,
      body: JSON.stringify(body),
      auth: true,
    });
  }

  /** `body` and `key` stay the same for every retry. */
  async openRotation(
    vaultId: string,
    key: string,
    body: string,
  ): Promise<OpenRotation> {
    const data = await this.#request({
      method: "POST",
      path: `${vaultPath(vaultId)}/rotations`,
      body,
      auth: true,
      idempotent: true,
      headers: { "Idempotency-Key": key },
    });
    return parse(OpenRotationSchema, data);
  }

  async uploadRotationObjects(
    vaultId: string,
    rotationId: string,
    key: string,
    body: string,
  ): Promise<void> {
    await this.#request({
      method: "PUT",
      path: `${vaultPath(vaultId)}/rotations/${encodeURIComponent(rotationId)}/objects`,
      body,
      auth: true,
      idempotent: true,
      timeoutMs: BATCH_TIMEOUT_MS,
      headers: { "Idempotency-Key": key },
    });
  }

  async commitRotation(
    vaultId: string,
    rotationId: string,
    key: string,
    body: string,
  ): Promise<number> {
    const data = await this.#request({
      method: "POST",
      path: `${vaultPath(vaultId)}/rotations/${encodeURIComponent(rotationId)}/commit`,
      body,
      auth: true,
      idempotent: true,
      timeoutMs: BATCH_TIMEOUT_MS,
      headers: { "Idempotency-Key": key },
    });
    return parse(RevisionSchema, data).revision;
  }

  /**
   * Starts an attachment upload. A retry after a lost response finds the
   * fresh ID taken (`409`): that upload is ours.
   */
  async createAttachment(
    vaultId: string,
    attachmentId: string,
    entryId: string,
    size: number,
  ): Promise<AttachmentUpload> {
    try {
      const data = await this.#request({
        method: "POST",
        path: attachmentsPath(vaultId),
        body: JSON.stringify({
          attachment_id: attachmentId,
          entry_id: entryId,
          size,
        }),
        auth: true,
        idempotent: true,
      });
      return parse(AttachmentUploadSchema, data);
    } catch (error) {
      if (error instanceof ApiError && error.code === "conflict")
        return { part_size: PART_SIZE, parts: Math.ceil(size / PART_SIZE) };
      throw error;
    }
  }

  /** A part replaces an earlier upload of itself, so retries are safe. */
  async putAttachmentPart(
    vaultId: string,
    attachmentId: string,
    part: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#request({
      method: "PUT",
      path: `${attachmentPath(vaultId, attachmentId)}/parts/${String(part)}`,
      body: bytes,
      auth: true,
      idempotent: true,
      timeoutMs: BATCH_TIMEOUT_MS,
      signal,
    });
  }

  async completeAttachment(
    vaultId: string,
    attachmentId: string,
  ): Promise<void> {
    await this.#request({
      method: "POST",
      path: `${attachmentPath(vaultId, attachmentId)}/complete`,
      auth: true,
      idempotent: true,
    });
  }

  /** The encrypted blob; stops after 30 s without data. */
  async downloadAttachment(
    vaultId: string,
    attachmentId: string,
    run: BytesRun = {},
  ): Promise<Uint8Array> {
    return (await this.#request({
      method: "GET",
      path: attachmentPath(vaultId, attachmentId),
      auth: true,
      bytes: run,
      signal: run.signal,
    })) as Uint8Array;
  }

  /** An unknown or already deleted attachment counts as deleted. */
  async deleteAttachment(vaultId: string, attachmentId: string): Promise<void> {
    try {
      await this.#request({
        method: "DELETE",
        path: attachmentPath(vaultId, attachmentId),
        auth: true,
        idempotent: true,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return;
      throw error;
    }
  }

  async transferAttachment(
    vaultId: string,
    attachmentId: string,
    targetVaultId: string,
    targetEntryId: string,
  ): Promise<void> {
    await this.#request({
      method: "POST",
      path: `${attachmentPath(vaultId, attachmentId)}/transfer`,
      body: JSON.stringify({
        target_vault_id: targetVaultId,
        target_entry_id: targetEntryId,
      }),
      auth: true,
      idempotent: true,
    });
  }

  /** A valid access token for the `auth` message of the WebSocket. */
  async socketToken(): Promise<string> {
    return this.#access && this.#access.expiresAt > this.#now()
      ? this.#access.token
      : this.#refresh(this.#access?.token);
  }

  /** `wss://…/v1/events` for the API base URL. */
  get eventsUrl(): string {
    return `${this.#baseUrl.replace(/^http/, "ws")}/v1/events`;
  }

  #adoptSession(session: v.InferOutput<typeof SessionSchema>): SessionCreated {
    this.#access = {
      token: session.access_token,
      expiresAt: this.#expiry(session.access_expires_in),
    };
    return { sessionId: session.session_id, userId: session.user_id };
  }

  #expiry(expiresInSeconds: number): number {
    const margin = Math.min(30, expiresInSeconds / 2);
    return this.#now() + (expiresInSeconds - margin) * 1000;
  }

  async #request(call: Call): Promise<unknown> {
    if (!call.auth) return this.#send(call, undefined);
    let token =
      this.#access && this.#access.expiresAt > this.#now()
        ? this.#access.token
        : await this.#refresh(this.#access?.token);
    try {
      return await this.#send(call, token);
    } catch (error) {
      if (!(
        error instanceof ApiError &&
        error.status === 401 &&
        error.code === "session_invalid"
      ))
        throw error;
      token = await this.#refresh(token);
      return this.#send(call, token);
    }
  }

  /** Lets concurrent callers in this tab share one refresh. */
  #refresh(stale: string | undefined): Promise<string> {
    this.#refreshing ??= (async () => {
      try {
        const fresh = await this.#coordinator.refresh(stale, () =>
          this.#performRefresh(),
        );
        this.#access = fresh;
        return fresh;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401)
          this.#access = undefined;
        throw error;
      } finally {
        this.#refreshing = undefined;
      }
    })();
    return this.#refreshing.then((fresh) => fresh.token);
  }

  /** `409 refresh_superseded`: two retries within 20 s at most. */
  async #performRefresh(): Promise<AccessToken> {
    const started = this.#now();
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await this.#fetchOnce(
          {
            method: "POST",
            path: "/v1/auth/refresh",
            auth: false,
            cookie: true,
          },
          undefined,
        );
        const refreshed = parse(TokenRefreshSchema, data);
        return {
          token: refreshed.access_token,
          expiresAt: this.#expiry(refreshed.access_expires_in),
        };
      } catch (error) {
        const delay = SUPERSEDED_RETRY_DELAYS[attempt];
        if (
          !(error instanceof ApiError && error.code === "refresh_superseded") ||
          delay === undefined ||
          this.#now() + delay - started > SUPERSEDED_WINDOW_MS
        )
          throw error;
        await this.#sleep(delay);
      }
    }
  }

  /**
   * Reading and idempotent requests are retried twice on network errors,
   * 5xx and 408, with the same bytes.
   */
  async #send(call: Call, token: string | undefined): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#fetchOnce(call, token);
      } catch (error) {
        // `507 quota_exceeded` does not go away by waiting.
        const retryable =
          (error instanceof NetworkError && error.reason !== "response") ||
          (error instanceof ApiError &&
            ((error.status >= 500 && error.status !== 507) ||
              error.status === 408));
        const delay = RETRY_DELAYS[attempt];
        if (
          !(call.method === "GET" || call.idempotent === true) ||
          call.once === true ||
          call.signal?.aborted === true ||
          !retryable ||
          delay === undefined
        )
          throw error;
        await this.#sleep(delay);
      }
    }
  }

  async #fetchOnce(call: Call, token: string | undefined): Promise<unknown> {
    const binary = call.body instanceof Uint8Array;
    const headers: Record<string, string> = {
      Accept: call.bytes ? "application/octet-stream" : "application/json",
      "X-Keeman-Client": this.#clientId,
      ...call.headers,
    };
    if (call.body !== undefined)
      headers["Content-Type"] = binary
        ? "application/octet-stream"
        : "application/json";
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    // Downloads end after a pause in the data, other requests after a fixed time.
    const idle = call.bytes ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
      if (!idle) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        idle.abort(new DOMException("idle", "TimeoutError"));
      }, IDLE_TIMEOUT_MS);
    };
    const signals = [
      idle?.signal ?? AbortSignal.timeout(call.timeoutMs ?? this.#timeoutMs),
      ...(call.signal ? [call.signal] : []),
    ];
    const failed = (error: unknown): never => {
      if (call.signal?.aborted) throw call.signal.reason;
      throw new NetworkError(isTimeout(error) ? "timeout" : "network");
    };
    watch();
    try {
      let response: Response;
      try {
        response = await this.#fetch(this.#baseUrl + call.path, {
          method: call.method,
          headers,
          body: call.body as BodyInit | undefined,
          credentials: call.cookie ? "include" : "omit",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.any(signals),
        });
      } catch (error) {
        return failed(error);
      }
      if (!response.ok) throw await toApiError(response);
      if (call.bytes) {
        try {
          return await readBytes(response, call.bytes, watch);
        } catch (error) {
          // Too many bytes: the same answer would come again.
          if (error instanceof NetworkError) throw error;
          return failed(error);
        }
      }
      if (response.status === 204) return undefined;
      try {
        // `201` of an invitation has no body.
        const text = await response.text();
        return text === "" ? undefined : (JSON.parse(text) as unknown);
      } catch {
        throw new NetworkError("response");
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

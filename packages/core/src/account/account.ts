import type {
  ApiClient,
  RecoverStartOutcome,
  RecoveryPayload,
  SecondFactorChallenge,
  SecondFactorOutcome,
} from "../api/client";
import { ApiError, NetworkError } from "../api/errors";
import type { components } from "../api/openapi.gen";
import type {
  Me,
  PasskeyInfo,
  SecondFactorMethod,
  SessionInfo,
} from "../api/schemas";
import { aad } from "../crypto/aad";
import {
  isWeakerThan,
  validateKdfParams,
  type KdfParams,
} from "../crypto/argon2";
import {
  deriveLoginKeysInWorker,
  type WorkerLike,
} from "../crypto/argon2-worker";
import {
  bytesEqual,
  fromBase64Url,
  toBase64Url,
  wipe,
  type JsonObject,
} from "../crypto/bytes";
import { openKey } from "../crypto/envelope";
import { CryptoError } from "../crypto/errors";
import {
  fingerprint2Hex,
  fingerprintHex,
  formatFingerprint,
} from "../crypto/fingerprint";
import {
  buildPasswordChange,
  buildRecoveryFinish,
  buildRecoveryMaterial,
  buildRegistration,
  newPasswordSetup,
  startRecovery,
  unlockAccount,
  unlockWithUserKey,
  unwrapRecoveredUserKey,
  type Registration,
} from "../crypto/flows/account";
import type { AccountKeys } from "../crypto/kdf";
import { KeyStore, type AccountKeyMaterial } from "../crypto/keystore";
import { normalizeEmail } from "../crypto/normalize";
import { decryptUserData, encryptUserData } from "../crypto/objects";
import { systemRandomness } from "../crypto/random";
import { signFreshness, type UserDataFreshness } from "../crypto/freshness";
import {
  formatPairingCode,
  generatePairingSecret,
  openPairing,
  parsePairingCode,
  sealPairing,
  type PairingContent,
} from "../crypto/pairing";
import type { RolePoint } from "../crypto/roles";
import { signingPublicKeyOf } from "../crypto/signing";
import {
  attestedAt,
  DAY_MS,
  effectivePeriodDays,
  ownUserDataAttestation,
  RENEW_AFTER_MS,
} from "../sync/freshness";
import {
  applyUserDataChange,
  effectiveSettings,
  initialUserData,
  inspectUserData,
  isRecoveryKeyConfirmed,
  mergeUserData,
  SETTING_DEFAULTS,
  USER_DATA_SCHEMA,
  type Language,
  type Settings,
  type SettingsChange,
  type UserDataChange,
  type UserDataState,
} from "../model/user-data";
import { seqOf } from "../model/json";
import {
  contactsOf,
  roleAnchorOf,
  vaultOrderOf,
  type Contact,
} from "../model/user-data";
import { keyOf, type Candidate } from "../sharing/candidate";
import { contactViews, type ContactView } from "../sharing/contacts";
import { SyncEngine, type SyncEngineOptions } from "../sync/engine";
import { SyncError } from "../sync/errors";
import {
  inMemorySyncMarks,
  isUserDataOlder,
  type SyncMarks,
  type UserMarks,
} from "../sync/marks";
import { AccountError } from "./errors";
import {
  inMemoryKdfMemory,
  isBelowDefault,
  strongerOf,
  type KdfMemory,
} from "./kdf-memory";

type Device = components["schemas"]["Device"];

export interface AccountOptions {
  api: ApiClient;
  /** Starts a fresh Argon2 worker. */
  spawnWorker: () => WorkerLike;
  device: Device;
  kdfMemory?: KdfMemory;
  /** Rollback marks of this device (`keeman.syncSeen`). */
  syncMarks?: SyncMarks;
  /** Clock for the lifetime of second-factor steps and recoveries. */
  now?: () => number;
}

/** What the UI should point out after login or unlock. */
export interface UnlockReport {
  /** Weaker than last seen on this device: ask "raise" / "understood". */
  kdfWeakerThanSeen: boolean;
  kdfBelowDefault: boolean;
  recoveryKeyUnconfirmed: boolean;
  userDataCorrupt: boolean;
  userDataReadOnly: boolean;
  /** The server delivered older user_data than seen before. */
  userDataRollback: boolean;
  /** No device of the account confirmed the delivered user_data in time. */
  userDataStale: boolean;
  /** This device had no marks for the account yet (offer pairing). */
  newDevice: boolean;
  /** Unused backup codes left after a login with a backup code. */
  backupCodesRemaining?: number;
}

/** A login either unlocks at once or needs the second factor. */
export type LoginResult =
  | { kind: "unlocked"; report: UnlockReport }
  | { kind: "second_factor"; step: SecondFactorLogin };

/** Open steps that hold key material until they end. */
interface Discardable {
  discard(): void;
}

export interface RegistrationInput {
  email: string;
  password: string;
  inviteCode?: string;
  language: Language;
}

const MAX_ATTEMPTS = 3;

/** Errors after which a registration attempt cannot be retried unchanged. */
const FINAL_REGISTRATION_CODES = new Set([
  "invite_invalid",
  "email_taken",
  "registration_closed",
  "validation_failed",
  "kdf_params_invalid",
  "conflict",
]);

function isTransient(error: unknown): boolean {
  return (
    error instanceof NetworkError ||
    (error instanceof ApiError && error.status >= 500)
  );
}

function cost(kdf: KdfParams): { ops: number; mem: number } {
  return { ops: kdf.ops, mem: kdf.mem };
}

function validKdf(value: unknown): KdfParams {
  try {
    return validateKdfParams(value);
  } catch {
    throw new AccountError("kdf_invalid");
  }
}

interface UserDataSlot {
  revision: number;
  state: UserDataState;
  /** Older than seen before: read-only until acknowledged. */
  rollback: boolean;
  /** Not confirmed within the period: read-only until acknowledged. */
  stale: boolean;
  /** The own attestation of user_data that checked out, if any. */
  attestation: UserDataFreshness | undefined;
  /** The last confirmation known (Unix ms). */
  confirmedSince: number | undefined;
}

/**
 * The account of one signed-in user: registration, login, unlock,
 * lock and the account settings. Keys live only in the internal KeyStore;
 * every builder gets the system randomness.
 */
export class Account {
  readonly #api: ApiClient;
  readonly #spawn: () => WorkerLike;
  readonly #device: Device;
  readonly #memory: KdfMemory;
  readonly #marks: SyncMarks;
  readonly #keys = new KeyStore();
  readonly #now: () => number;
  /** Second-factor steps and recoveries; lock and logout discard them. */
  readonly #pending = new Set<Discardable>();
  #engine: SyncEngine | undefined;
  /**
   * Raised by every lock. An operation remembers it when it starts and
   * checks it after each wait: one that a lock overtook takes over nothing.
   */
  #epoch = 0;
  #email: string | undefined;
  #userId: string | undefined;
  #kdf: KdfParams | undefined;
  #userData: UserDataSlot | undefined;
  /** The server has no signing key of this account yet. */
  #signingKeyMissing = false;
  /** Whether the server knows signing keys and roles chains, asked once. */
  #rolesFeature: Promise<boolean> | undefined;
  /** The answer, once there is one. */
  #rolesKnown: boolean | undefined;
  /** Whether the server stores freshness attestations, asked once. */
  #freshnessFeature: Promise<boolean> | undefined;
  /** The period this device last confirmed (`fd` of the marks). */
  #periodFloor: number | undefined;
  /** No marks for the account on this device at the unlock. */
  #newDevice = false;
  /** The last uploaded attestation of user_data. */
  #userDataAttested: { at: number; seq: number } | undefined;
  /** The time of an attestation of user_data the user overruled. */
  #userDataOverruled: number | undefined;

  constructor(options: AccountOptions) {
    this.#api = options.api;
    this.#spawn = options.spawnWorker;
    this.#device = options.device;
    this.#memory = options.kdfMemory ?? inMemoryKdfMemory();
    this.#marks = options.syncMarks ?? inMemorySyncMarks();
    this.#now = options.now ?? Date.now;
  }

  get isUnlocked(): boolean {
    return this.#keys.isUnlocked;
  }

  /** Known after login or unlock; kept while locked. */
  get userId(): string | undefined {
    return this.#userId;
  }

  get email(): string | undefined {
    return this.#email;
  }

  get kdf(): KdfParams | undefined {
    return this.#kdf;
  }

  /**
   * The decrypted user_data, only while the keys are there: a late answer
   * of a write must not make it readable while locked.
   */
  #slot(): UserDataSlot | undefined {
    return this.#keys.isUnlocked ? this.#userData : undefined;
  }

  get userDataState(): UserDataState | undefined {
    return this.#slot()?.state;
  }

  get settings(): Settings {
    const state = this.#slot()?.state;
    return state?.status === "ok"
      ? effectiveSettings(state.raw)
      : { ...SETTING_DEFAULTS };
  }

  get recoveryKeyConfirmed(): boolean {
    const state = this.#slot()?.state;
    return state?.status !== "ok" || isRecoveryKeyConfirmed(state.raw);
  }

  get userDataRollback(): boolean {
    return this.#slot()?.rollback ?? false;
  }

  /** `vaultOrder` of user_data. */
  get vaultOrder(): string[] {
    const state = this.#slot()?.state;
    return state?.status === "ok" ? vaultOrderOf(state.raw) : [];
  }

  /** The running sync of the unlocked account. */
  get sync(): SyncEngine | undefined {
    return this.#engine;
  }

  // ------------------------------------------------------------ contacts

  /**
   * The own fingerprint in display form, only from the locally derived
   * public key, never from the server's.
   */
  get ownFingerprint(): string | undefined {
    if (!this.#keys.isUnlocked) return undefined;
    // A server without signing keys: others compare version 1.
    if (this.#rolesKnown === false)
      return formatFingerprint(fingerprintHex(this.#keys.publicKey));
    return formatFingerprint(
      fingerprint2Hex(this.#keys.publicKey, this.#keys.signingPublicKey()),
    );
  }

  /**
   * Contacts that count for the fingerprint rule: none while user_data is
   * corrupt or rolled back without acknowledgment.
   */
  #trustedContacts(): readonly Contact[] {
    const slot = this.#slot();
    // Unconfirmed user_data might still list a contact removed since.
    if (slot?.state.status !== "ok" || slot.rollback || slot.stale) return [];
    return contactsOf(slot.state.raw);
  }

  get contacts(): ContactView[] {
    return contactViews(this.#trustedContacts());
  }

  /** Confirmations can be stored; otherwise sharing waits. */
  get contactsWritable(): boolean {
    const slot = this.#slot();
    return (
      slot?.state.status === "ok" && !slot.state.readOnly && !slot.rollback
    );
  }

  /** The address of a contact, e.g. for "by whom". */
  contactEmail(userId: string): string | undefined {
    return this.#trustedContacts().find((c) => c.userId === userId)?.email;
  }

  /**
   * "Matches" in the fingerprint dialog: stores the candidate as
   * a verified contact with the key the core loaded for it.
   */
  async verifyContact(candidate: Candidate): Promise<void> {
    this.#requireContactsWritable();
    const { fingerprints } = keyOf(candidate);
    // Without a signing key there is nothing to compare yet, unless the
    // server knows no signing keys at all.
    if (fingerprints.v2 === undefined && fingerprints.legacy !== true)
      throw new SyncError("unverifiable");
    await this.#updateUserData({
      contacts: [
        {
          kind: "verify",
          userId: candidate.userId,
          email: candidate.email,
          fingerprint: fingerprints.v1,
          fingerprint2: fingerprints.v2,
          verifiedAt: new Date().toISOString(),
        },
      ],
    });
    this.#engine?.contactsChanged();
  }

  async removeContact(userId: string): Promise<void> {
    this.#requireContactsWritable();
    await this.#updateUserData({ contacts: [{ kind: "remove", userId }] });
    this.#engine?.contactsChanged();
  }

  #requireContactsWritable(): void {
    if (this.contactsWritable) return;
    throw new AccountError(
      this.#userData?.state.status === "corrupt"
        ? "user_data_corrupt"
        : "user_data_read_only",
    );
  }

  // ------------------------------------------------------------ registration

  /** Builds the request once; `submit()` may be repeated unchanged. */
  async startRegistration(
    input: RegistrationInput,
  ): Promise<PendingRegistration> {
    const epoch = this.#epoch;
    const setup = newPasswordSetup(systemRandomness);
    const loginKeys = await this.#derive(input.password, setup.salt, setup.kdf);
    try {
      const userData = initialUserData(input.language);
      const registration = buildRegistration(systemRandomness, {
        email: input.email,
        ...setup,
        loginKeys,
        userData,
      });
      const signingKey = (await this.#rolesSupported())
        ? toBase64Url(signingPublicKeyOf(registration.account.userKey))
        : undefined;
      const body = JSON.stringify({
        ...(input.inviteCode === undefined
          ? {}
          : { invite_code: input.inviteCode }),
        ...registration.request,
        ...(signingKey ? { signing_public_key: signingKey } : {}),
        device: this.#device,
      });
      return new PendingRegistration(body, registration, userData, {
        register: (request) => this.#api.register(request),
        loginWithBody: (request, material) =>
          this.#completeExisting(request, material),
        adopt: async (material, data) => {
          this.#current(epoch);
          this.#adopt(material, data);
          // Made on this device: its user_data is current, and other
          // devices learn so from the attestation.
          await this.#marks.raise(material.userId, {
            uf: this.#now(),
            fd: SETTING_DEFAULTS.freshnessDays,
            vaults: {},
          });
          await this.#attestUserData().catch(() => undefined);
        },
      });
    } finally {
      wipe(loginKeys.authKey, loginKeys.wrapKey);
    }
  }

  /** `409 already_registered`: log in with the stored request. */
  async #completeExisting(
    request: Registration["request"],
    material: AccountKeyMaterial,
  ): Promise<{ me: Me; userData: JsonObject | undefined }> {
    const outcome = await this.#api.login({
      email: request.email,
      auth_key: request.auth_key,
      device: this.#device,
    });
    if (outcome.kind !== "session") throw new AccountError("integrity");
    const me = await this.#api.me();
    if (
      me.user_id !== request.user_id ||
      outcome.userId !== request.user_id ||
      me.user_key_wrapped !== request.user_key_wrapped
    )
      throw new AccountError("integrity");
    let userData: JsonObject | undefined;
    try {
      userData = decryptUserData(
        material.userKey,
        me.user_id,
        me.user_data.data,
      );
    } catch {
      userData = undefined;
    }
    return { me, userData };
  }

  #adopt(
    material: AccountKeyMaterial,
    data: {
      email: string;
      kdf: KdfParams;
      revision: number;
      userData: JsonObject | undefined;
    },
  ): void {
    this.#keys.unlock(material);
    this.#userId = material.userId;
    this.#email = data.email;
    this.#kdf = data.kdf;
    this.#userData = {
      revision: data.revision,
      state: inspectUserData(data.userData),
      rollback: false,
      stale: false,
      attestation: undefined,
      confirmedSince: undefined,
    };
    this.#memory.set(material.userId, cost(data.kdf));
  }

  // ------------------------------------------------------------ login, unlock

  /**
   * Full login including the unlock with the derived wrap_key, or
   * the second-factor step, which then holds only wrap_key.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const epoch = this.#epoch;
    const normalized = normalizeEmail(email);
    const prelogin = await this.#api.prelogin(normalized);
    this.#current(epoch);
    const kdf = validKdf(prelogin.kdf);
    const keys = await this.#derive(
      password,
      fromBase64Url(prelogin.salt, 16),
      kdf,
    );
    try {
      this.#current(epoch);
      const outcome = await this.#api.login({
        email: normalized,
        auth_key: toBase64Url(keys.authKey),
        device: this.#device,
      });
      this.#current(epoch);
      if (outcome.kind === "second_factor") {
        const step = new SecondFactorLogin(
          outcome.challenge,
          keys.wrapKey.slice(),
          this.#secondFactorSteps(kdf, epoch),
        );
        this.#pending.add(step);
        return { kind: "second_factor", step };
      }
      const report = await this.#finishLogin(
        outcome.userId,
        keys.wrapKey,
        kdf,
        epoch,
      );
      await this.#addSigningKey(toBase64Url(keys.authKey), epoch);
      return { kind: "unlocked", report };
    } finally {
      wipe(keys.authKey, keys.wrapKey);
    }
  }

  /**
   * Loads the account, unwraps the keys and checks the key pair once there
   * is a session; `kdf` are the `prelogin` parameters derived with.
   */
  async #finishLogin(
    userId: string,
    wrapKey: Uint8Array,
    kdf: KdfParams,
    epoch: number,
  ): Promise<UnlockReport> {
    this.#current(epoch);
    const me = await this.#api.me();
    this.#current(epoch);
    if (me.user_id !== userId) throw new AccountError("integrity");
    const report = this.#unlockWith(me, wrapKey, kdf, true);
    return this.#checkUserDataMarks(report, epoch);
  }

  #secondFactorSteps(kdf: KdfParams, epoch: number): SecondFactorSteps {
    return {
      api: this.#api,
      now: this.#now,
      complete: async (outcome, wrapKey) => {
        // A lock wiped the step's key: that is not an integrity problem.
        this.#current(epoch);
        if (outcome.kind !== "session") throw new AccountError("integrity");
        return this.#finishLogin(outcome.userId, wrapKey, kdf, epoch);
      },
      release: (step) => {
        this.#pending.delete(step);
      },
    };
  }

  /** Ends open second-factor steps and recoveries; their keys are wiped. */
  #discardPending(): void {
    for (const step of [...this.#pending]) step.discard();
    this.#pending.clear();
  }

  /** Unlock with an existing session. */
  async unlock(password: string): Promise<UnlockReport> {
    const epoch = this.#epoch;
    const me = await this.#api.me();
    this.#current(epoch);
    const kdf = validKdf(me.kdf);
    const keys = await this.#derive(password, fromBase64Url(me.salt, 16), kdf);
    try {
      this.#current(epoch);
      const report = this.#unlockWith(me, keys.wrapKey, kdf, false);
      const checked = await this.#checkUserDataMarks(report, epoch);
      await this.#addSigningKey(toBase64Url(keys.authKey), epoch);
      return checked;
    } finally {
      wipe(keys.authKey, keys.wrapKey);
    }
  }

  #rolesSupported(): Promise<boolean> {
    this.#rolesFeature ??= this.#api.config().then(
      (config) => {
        this.#rolesKnown = config.features.roles === true;
        return this.#rolesKnown;
      },
      () => {
        this.#rolesFeature = undefined;
        return false;
      },
    );
    return this.#rolesFeature;
  }

  /**
   * An account from before signing keys adds its key, derived from the user
   * key, with a reauth token for the auth key just derived. Network errors
   * leave it for the next unlock; a different stored key is an integrity
   * error. After a login with a second factor the auth key is gone, so the
   * key follows at the next unlock.
   */
  async #addSigningKey(authKey: string, epoch: number): Promise<void> {
    if (!this.#signingKeyMissing || !(await this.#rolesSupported())) return;
    this.#current(epoch);
    const signingKey = toBase64Url(this.#keys.signingPublicKey());
    try {
      const token = await this.#api.reauth(authKey);
      this.#current(epoch);
      await this.#api.putSigningKey(token, signingKey);
      this.#current(epoch);
      this.#signingKeyMissing = false;
    } catch (error) {
      if (error instanceof AccountError) throw error;
      if (error instanceof ApiError && error.code === "conflict") {
        this.lock();
        throw new AccountError("integrity");
      }
    }
  }

  /** Throws `locked` if a lock came after the operation began at `epoch`. */
  #current(epoch: number): void {
    if (epoch !== this.#epoch) throw new AccountError("locked");
  }

  /**
   * Unwraps with the key derived with `kdf`, which are also the parameters
   * compared with the ones seen before: from `prelogin` after a login, from
   * `GET /v1/me` when unlocking.
   */
  #unlockWith(
    me: Me,
    wrapKey: Uint8Array,
    kdf: KdfParams,
    afterLogin: boolean,
  ): UnlockReport {
    const seen = this.#memory.get(me.user_id);
    const weaker =
      seen !== undefined &&
      isWeakerThan(kdf, { alg: "argon2id13", ops: seen.ops, mem: seen.mem });
    let unlocked;
    try {
      unlocked = unlockAccount(me, wrapKey);
    } catch (error) {
      if (error instanceof CryptoError && error.code === "auth" && !afterLogin)
        throw new AccountError("wrong_password", weaker);
      // After a login with weaker parameters the server may have made
      // them up: the error says so.
      throw new AccountError("integrity", weaker);
    }
    this.#keys.unlock(unlocked.account);
    this.#userId = me.user_id;
    this.#email = me.email;
    this.#kdf = kdf;
    this.#signingKeyMissing = unlocked.signingKey === "missing";
    this.#userData = {
      revision: me.user_data.revision,
      state: inspectUserData(unlocked.userData),
      rollback: false,
      stale: false,
      attestation: this.#userDataAttestation(me, me.user_id),
      confirmedSince: undefined,
    };
    if (!weaker) this.#memory.set(me.user_id, cost(kdf));
    const state = this.#userData.state;
    return {
      kdfWeakerThanSeen: weaker,
      kdfBelowDefault: isBelowDefault(kdf),
      recoveryKeyUnconfirmed: !this.recoveryKeyConfirmed,
      userDataCorrupt: state.status === "corrupt",
      userDataReadOnly: state.status === "ok" && state.readOnly,
      userDataRollback: false,
      userDataStale: false,
      newDevice: false,
    };
  }

  /**
   * Rollback check of user_data against the marks. A lock while the marks
   * are read ends the unlock: the keys are gone, nothing is reported.
   */
  async #checkUserDataMarks(
    report: UnlockReport,
    epoch: number,
  ): Promise<UnlockReport> {
    const userId = this.#userId;
    if (userId !== undefined) {
      const before = await this.#marks.read(userId);
      this.#current(epoch);
      this.#newDevice =
        before.ud === undefined && Object.keys(before.vaults).length === 0;
    }
    const { rollback, stale } = await this.#applyUserDataMarks();
    this.#current(epoch);
    const checked = { ...report, newDevice: this.#newDevice };
    if (rollback)
      return { ...checked, userDataRollback: true, userDataReadOnly: true };
    if (stale)
      return { ...checked, userDataStale: true, userDataReadOnly: true };
    void this.#attestUserData().catch(() => undefined);
    return checked;
  }

  /**
   * Checks user_data against the marks and the own attestation (a floor
   * whatever its age): rolled back, or else confirmed within the period
   * or stale. Raises the marks.
   */
  async #applyUserDataMarks(): Promise<{ rollback: boolean; stale: boolean }> {
    const slot = this.#userData;
    const userId = this.#userId;
    if (!slot || userId === undefined || slot.state.status !== "ok")
      return { rollback: false, stale: false };
    const seq = seqOf(slot.state.raw);
    const attestation = slot.attestation;
    const marks = await this.#marks.read(userId);
    this.#periodFloor = marks.fd;
    const floor: [number, number] = [
      marks.ud?.[0] ?? 0,
      Math.max(marks.ud?.[1] ?? 0, attestation?.seq ?? 0),
    ];
    if (attestation)
      await this.#marks.raise(userId, { ud: [0, attestation.seq], vaults: {} });
    if (isUserDataOlder(floor, slot.revision, seq)) {
      slot.rollback = true;
      slot.state = { ...slot.state, readOnly: true };
      return { rollback: true, stale: false };
    }
    await this.#marks.raise(userId, { ud: [slot.revision, seq], vaults: {} });
    const now = this.#now();
    // Marks from before confirmation times: the first check confirms.
    const transition = marks.ud !== undefined && marks.uf === undefined;
    const attested =
      attestation && seq >= attestation.seq
        ? (attestedAt(attestation.time, now) ?? 0)
        : 0;
    const basis = transition ? now : Math.max(marks.uf ?? 0, attested);
    const days = effectivePeriodDays(
      effectiveSettings(slot.state.raw).freshnessDays,
      marks.fd,
    );
    if (basis > 0 && basis >= now - days * DAY_MS) {
      await this.#confirmUserData(userId, slot);
      return { rollback: false, stale: false };
    }
    slot.confirmedSince = basis > 0 ? basis : undefined;
    this.#markStale(slot, true);
    if (marks.uf === undefined)
      await this.#marks.raise(userId, { uf: 0, vaults: {} });
    return { rollback: false, stale: true };
  }

  /** "Understood": the delivered user_data becomes the new mark. */
  async acknowledgeUserDataRollback(): Promise<void> {
    const epoch = this.#epoch;
    const slot = this.#userData;
    const userId = this.#requireUnlocked();
    if (!slot?.rollback || slot.state.status !== "ok") return;
    // An own attestation that says otherwise counts no more; a new one
    // replaces it below.
    if (slot.attestation)
      this.#userDataOverruled = Date.parse(slot.attestation.time);
    slot.attestation = undefined;
    this.#userDataAttested = undefined;
    await this.#marks.replaceUserData(userId, [
      slot.revision,
      seqOf(slot.state.raw),
    ]);
    this.#current(epoch);
    slot.rollback = false;
    slot.state = {
      ...slot.state,
      readOnly: (slot.state.raw.schema as number) > USER_DATA_SCHEMA,
    };
    this.#engine?.contactsChanged();
    await this.#attestUserData();
  }

  /** After `user_data_changed`: loads a newer user_data. */
  async reloadUserData(revision?: number): Promise<void> {
    const epoch = this.#epoch;
    const userId = this.#requireUnlocked();
    const slot = this.#userData;
    if (slot && revision !== undefined && revision <= slot.revision) return;
    const me = await this.#api.me();
    this.#current(epoch);
    if (me.user_id !== userId) throw new AccountError("integrity");
    this.#userData = {
      revision: me.user_data.revision,
      state: inspectUserData(this.#decryptUserData(userId, me)),
      rollback: false,
      stale: false,
      attestation: this.#userDataAttestation(me, userId),
      confirmedSince: undefined,
    };
    const { rollback, stale } = await this.#applyUserDataMarks();
    if (!rollback && !stale) void this.#attestUserData().catch(() => undefined);
  }

  /** The user accepted weaker parameters. */
  acknowledgeKdf(): void {
    if (this.#userId !== undefined && this.#kdf !== undefined)
      this.#memory.set(this.#userId, cost(this.#kdf));
  }

  /**
   * Wipes keys and decrypted user data; the session stays. Open
   * second-factor steps and recoveries end as well.
   */
  lock(): void {
    this.#epoch += 1;
    this.#discardPending();
    this.#engine?.stop();
    this.#engine = undefined;
    this.#keys.lock();
    this.#userData = undefined;
    this.#signingKeyMissing = false;
    // The server may be updated before the next unlock.
    this.#rolesFeature = undefined;
    this.#rolesKnown = undefined;
    this.#freshnessFeature = undefined;
    this.#periodFloor = undefined;
    this.#newDevice = false;
    this.#userDataAttested = undefined;
    this.#userDataOverruled = undefined;
  }

  /** Locks, forgets the account and revokes the session. */
  async logout(): Promise<void> {
    this.lock();
    this.#userId = undefined;
    this.#email = undefined;
    this.#kdf = undefined;
    await this.#api.logout();
  }

  // ------------------------------------------------------------ password, KDF

  /** Changes the master password; other sessions are revoked. */
  async changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await this.#changeLogin(currentPassword, newPassword, strongerOf, true);
  }

  /** Raises the KDF parameters: same password, chosen parameters, other sessions stay. */
  async upgradeKdf(password: string, kdf: KdfParams): Promise<void> {
    const target = validKdf(kdf);
    await this.#changeLogin(password, password, () => target, false);
  }

  async #changeLogin(
    currentPassword: string,
    newPassword: string,
    chooseKdf: (current: KdfParams) => KdfParams,
    revokeOtherSessions: boolean,
  ): Promise<void> {
    const epoch = this.#epoch;
    const userId = this.#requireUnlocked();
    const check = await this.#checkPassword(currentPassword);
    this.#current(epoch);
    let reauthToken = await this.#api.reauth(check.authKey);
    this.#current(epoch);
    const setup = newPasswordSetup(systemRandomness, chooseKdf(check.kdf));
    const newKeys = await this.#derive(newPassword, setup.salt, setup.kdf);
    let body: string;
    try {
      this.#current(epoch);
      body = JSON.stringify(
        this.#keys.useUserKey((userKey) =>
          buildPasswordChange(
            systemRandomness,
            { userId, userKey, ...setup, loginKeys: newKeys },
            revokeOtherSessions,
          ),
        ),
      );
    } finally {
      wipe(newKeys.authKey, newKeys.wrapKey);
    }
    const newSalt = toBase64Url(setup.salt);
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#api.putPassword(reauthToken, body);
        break;
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) throw error;
        if (error instanceof ApiError && error.code === "reauth_required") {
          reauthToken = await this.#api.reauth(check.authKey);
          continue;
        }
        if (!isTransient(error)) throw error;
        // The response may have been lost: look at the salt.
        const now = await this.#api.me();
        if (now.salt === newSalt) break;
        if (now.salt !== check.salt) throw error;
        reauthToken = await this.#api.reauth(check.authKey);
      }
    }
    // The change holds on the server either way: the parameters to expect
    // for this account are the new ones.
    this.#memory.set(userId, cost(setup.kdf));
    this.#current(epoch);
    this.#kdf = setup.kdf;
  }

  /**
   * Local check of the master password before any reauth, so
   * typos never count toward the login lockout.
   */
  async #checkPassword(
    password: string,
  ): Promise<{ authKey: string; salt: string; kdf: KdfParams }> {
    const userId = this.#requireUnlocked();
    const me = await this.#api.me();
    if (me.user_id !== userId) throw new AccountError("integrity");
    const kdf = validKdf(me.kdf);
    const keys = await this.#derive(password, fromBase64Url(me.salt, 16), kdf);
    let matches: boolean;
    try {
      const userKey = openKey(
        keys.wrapKey,
        me.user_key_wrapped,
        aad.userKey(userId),
      );
      matches = this.#keys.useUserKey((current) =>
        bytesEqual(current, userKey),
      );
      wipe(userKey);
    } catch {
      matches = false;
    }
    const authKey = toBase64Url(keys.authKey);
    wipe(keys.authKey, keys.wrapKey);
    if (!matches) throw new AccountError("wrong_password");
    return { authKey, salt: me.salt, kdf };
  }

  // ------------------------------------------------------------ recovery key

  /** Steps up to the display; `commit()` replaces the key. */
  async startRecoveryKeyRenewal(password: string): Promise<RecoveryKeyRenewal> {
    const userId = this.#requireUnlocked();
    const check = await this.#checkPassword(password);
    const reauthToken = await this.#api.reauth(check.authKey);
    const material = this.#keys.useUserKey((userKey) =>
      buildRecoveryMaterial(systemRandomness, userId, userKey),
    );
    return new RecoveryKeyRenewal(
      material.recoveryKeyDisplay,
      JSON.stringify(material.request),
      reauthToken,
      {
        put: (token, body) => this.#api.putRecovery(token, body),
        reauth: async (pw) => {
          const again = await this.#checkPassword(pw);
          return this.#api.reauth(again.authKey);
        },
        confirmed: async () => {
          if (!this.recoveryKeyConfirmed) await this.confirmRecoveryKey();
        },
      },
    );
  }

  // ------------------------------------------------------------ recovery

  /**
   * Starts a recovery with the typed recovery key. A typo fails
   * locally with `recovery_key_malformed`, before any request.
   */
  async startRecovery(
    email: string,
    recoveryKey: string,
  ): Promise<RecoveryProcess> {
    const epoch = this.#epoch;
    let start;
    try {
      start = startRecovery(recoveryKey);
    } catch (error) {
      if (error instanceof CryptoError && error.code === "validation")
        throw new AccountError("recovery_key_malformed");
      throw error;
    }
    const normalized = normalizeEmail(email);
    let outcome: RecoverStartOutcome;
    try {
      outcome = await this.#api.recoverStart(normalized, start.recoveryAuthKey);
      this.#current(epoch);
    } catch (error) {
      wipe(start.recoveryWrapKey);
      throw error;
    }
    const process = new RecoveryProcess(
      normalized,
      start.recoveryWrapKey,
      outcome,
      {
        api: this.#api,
        now: this.#now,
        device: this.#device,
        derive: (password, salt, kdf) => this.#derive(password, salt, kdf),
        unlock: async (me, userKey, kdf, authKey) => {
          const report = await this.#adoptRecovered(me, userKey, kdf, epoch);
          await this.#addSigningKey(authKey, epoch);
          return report;
        },
        release: (step) => {
          this.#pending.delete(step);
        },
      },
    );
    this.#pending.add(process);
    return process;
  }

  /** Unlocks with the recovered user key after the finish. */
  async #adoptRecovered(
    me: Me,
    userKey: Uint8Array,
    kdf: KdfParams,
    epoch: number,
  ): Promise<UnlockReport> {
    if (epoch !== this.#epoch) {
      // A lock wiped the process's key already; this copy goes too.
      wipe(userKey);
      throw new AccountError("locked");
    }
    let unlocked;
    try {
      unlocked = unlockWithUserKey(me, userKey);
    } catch {
      throw new AccountError("integrity");
    }
    this.#keys.unlock(unlocked.account);
    this.#userId = me.user_id;
    this.#email = me.email;
    this.#kdf = kdf;
    this.#signingKeyMissing = unlocked.signingKey === "missing";
    this.#userData = {
      revision: me.user_data.revision,
      state: inspectUserData(unlocked.userData),
      rollback: false,
      stale: false,
      attestation: this.#userDataAttestation(me, me.user_id),
      confirmedSince: undefined,
    };
    // An own password change: the new parameters are the ones to expect.
    this.#memory.set(me.user_id, cost(kdf));
    const state = this.#userData.state;
    const report = await this.#checkUserDataMarks(
      {
        kdfWeakerThanSeen: false,
        kdfBelowDefault: isBelowDefault(kdf),
        recoveryKeyUnconfirmed: false,
        userDataCorrupt: state.status === "corrupt",
        userDataReadOnly: state.status === "ok" && state.readOnly,
        userDataRollback: false,
        userDataStale: false,
        newDevice: false,
      },
      epoch,
    );
    // The new recovery key was confirmed before the finish.
    if (!this.recoveryKeyConfirmed && this.contactsWritable)
      await this.confirmRecoveryKey().catch(() => undefined);
    this.#current(epoch);
    return { ...report, recoveryKeyUnconfirmed: !this.recoveryKeyConfirmed };
  }

  /** Records that the user confirmed the recovery key. */
  async confirmRecoveryKey(): Promise<void> {
    await this.#updateUserData({ recoveryKeyConfirmed: true });
  }

  // ------------------------------------------------------------ user_data

  async updateSettings(change: SettingsChange): Promise<void> {
    await this.#updateUserData({ settings: change });
  }

  /**
   * Explicit reset of corrupt user_data: new defaults, never
   * automatic. The recovery key flag is left out (counts as confirmed).
   */
  async resetUserData(language: Language): Promise<void> {
    const epoch = this.#epoch;
    const userId = this.#requireUnlocked();
    if (this.#userData?.state.status !== "corrupt")
      throw new AccountError("user_data_read_only");
    const content = {
      schema: USER_DATA_SCHEMA,
      seq: 1,
      contacts: [],
      settings: { language },
    };
    const data = this.#keys.useUserKey((userKey) =>
      encryptUserData(systemRandomness, userKey, userId, content),
    );
    const revision = await this.#api.putUserData(this.#userData.revision, data);
    // A lock or another account meanwhile: nothing decrypted goes back in.
    this.#current(epoch);
    this.#userData = {
      revision,
      state: inspectUserData(content),
      rollback: false,
      stale: false,
      attestation: undefined,
      confirmedSince: undefined,
    };
    await this.#marks.raise(userId, { ud: [revision, 1], vaults: {} });
  }

  async #updateUserData(change: UserDataChange): Promise<void> {
    const epoch = this.#epoch;
    const userId = this.#requireUnlocked();
    const slot = this.#userData;
    if (!slot || slot.state.status !== "ok")
      throw new AccountError("user_data_corrupt");
    if (slot.state.readOnly) throw new AccountError("user_data_read_only");
    let base = slot.state.raw;
    let revision = slot.revision;
    let local = applyUserDataChange(base, change);
    for (let attempt = 1; ; attempt++) {
      const content = local;
      const data = this.#keys.useUserKey((userKey) =>
        encryptUserData(systemRandomness, userKey, userId, content),
      );
      try {
        const newRevision = await this.#api.putUserData(revision, data);
        // A lock or another account meanwhile: nothing decrypted goes back in.
        this.#current(epoch);
        this.#userData = {
          revision: newRevision,
          state: { status: "ok", raw: local, readOnly: false },
          rollback: false,
          stale: false,
          attestation: slot.attestation,
          confirmedSince: slot.confirmedSince,
        };
        await this.#marks.raise(userId, {
          ud: [newRevision, seqOf(local)],
          vaults: {},
        });
        void this.#attestUserData().catch(() => undefined);
        return;
      } catch (error) {
        if (!(error instanceof ApiError && error.code === "conflict"))
          throw error;
        if (attempt >= MAX_ATTEMPTS)
          throw new AccountError("conflict_unresolved");
      }
      const me = await this.#api.me();
      this.#current(epoch);
      const server = inspectUserData(this.#decryptUserData(userId, me));
      if (server.status !== "ok") throw new AccountError("user_data_corrupt");
      if (server.readOnly) throw new AccountError("user_data_read_only");
      local = mergeUserData(base, local, server.raw);
      base = server.raw;
      revision = me.user_data.revision;
    }
  }

  #decryptUserData(userId: string, me: Me): JsonObject | undefined {
    try {
      return this.#keys.useUserKey((userKey) =>
        decryptUserData(userKey, userId, me.user_data.data),
      );
    } catch {
      return undefined;
    }
  }

  /** Stores the order of the vaults the user chose. */
  async setVaultOrder(ids: string[]): Promise<void> {
    await this.#updateUserData({ vaultOrder: ids });
  }

  // ------------------------------------------------------------ sync

  /**
   * Starts the synchronisation of all vaults; it stops on lock.
   * Calling it again returns the running engine.
   */
  startSync(options: SyncEngineOptions = {}): SyncEngine {
    const userId = this.#requireUnlocked();
    if (this.#engine) return this.#engine;
    const engine = new SyncEngine(
      {
        api: this.#api,
        // Bound to this unlock: a task that outlives the engine adds no key
        // to a later one.
        keys: this.#keys.scope(),
        userId,
        marks: this.#marks,
        vaultOrder: () => this.vaultOrder,
        setVaultOrder: (ids) => this.setVaultOrder(ids),
        reauth: async (password) => {
          const check = await this.#checkPassword(password);
          return this.#api.reauth(check.authKey);
        },
        reloadUserData: (revision) => this.reloadUserData(revision),
        contacts: () => this.#trustedContacts(),
        roleAnchor: (vaultId) => {
          const slot = this.#slot();
          if (slot?.state.status !== "ok" || slot.rollback) return undefined;
          return roleAnchorOf(slot.state.raw, vaultId);
        },
        saveRoleAnchors: async (anchors) => {
          if (!this.contactsWritable) return;
          try {
            await this.#updateUserData({ roles: anchors });
          } catch (error) {
            if (error instanceof AccountError && error.code === "locked")
              throw error;
          }
        },
        now: () => this.#now(),
        freshnessPeriodDays: () => this.freshnessPeriodDays,
        attestUserData: () => this.#attestUserData(),
      },
      options,
    );
    this.#engine = engine;
    void engine.start();
    return engine;
  }

  // ------------------------------------------------------------ freshness

  #freshnessSupported(): Promise<boolean> {
    this.#freshnessFeature ??= this.#api.config().then(
      (config) => config.features.freshness === true,
      () => {
        this.#freshnessFeature = undefined;
        return false;
      },
    );
    return this.#freshnessFeature;
  }

  /** The effective confirmation period in days (never above the confirmed one). */
  get freshnessPeriodDays(): number {
    return effectivePeriodDays(this.settings.freshnessDays, this.#periodFloor);
  }

  /** No device of the account confirmed the delivered user_data in time. */
  get userDataStale(): boolean {
    return this.#slot()?.stale ?? false;
  }

  /** The last confirmation of user_data known (Unix ms). */
  get userDataConfirmedSince(): number | undefined {
    return this.#slot()?.confirmedSince;
  }

  /** This device had no marks for the account when it was unlocked. */
  get isNewDevice(): boolean {
    return this.#keys.isUnlocked && this.#newDevice;
  }

  /** The own attestation of `GET /v1/me`, unless the user overruled it. */
  #userDataAttestation(me: Me, userId: string): UserDataFreshness | undefined {
    const attestation = ownUserDataAttestation(
      me.freshness,
      userId,
      this.#keys.signingPublicKey(),
    );
    const overruled = this.#userDataOverruled;
    return attestation &&
      overruled !== undefined &&
      Date.parse(attestation.time) <= overruled
      ? undefined
      : attestation;
  }

  #markStale(slot: UserDataSlot, stale: boolean): void {
    slot.stale = stale;
    if (slot.state.status !== "ok") return;
    slot.state = {
      ...slot.state,
      readOnly:
        stale ||
        slot.rollback ||
        (slot.state.raw.schema as number) > USER_DATA_SCHEMA,
    };
  }

  /** Confirms the delivered user_data now; the period goes with it. */
  async #confirmUserData(userId: string, slot: UserDataSlot): Promise<void> {
    if (slot.state.status !== "ok") return;
    const now = this.#now();
    const days = effectiveSettings(slot.state.raw).freshnessDays;
    await this.#marks.raise(userId, { uf: now, fd: days, vaults: {} });
    this.#periodFloor = days;
    slot.confirmedSince = now;
    this.#markStale(slot, false);
  }

  /** "Understood" at unconfirmed user_data: it counts as current now. */
  async acknowledgeUserDataFreshness(): Promise<void> {
    const epoch = this.#epoch;
    const userId = this.#requireUnlocked();
    const slot = this.#userData;
    if (!slot?.stale) return;
    await this.#confirmUserData(userId, slot);
    this.#current(epoch);
    this.#engine?.contactsChanged();
    await this.#attestUserData();
  }

  /**
   * Signs and uploads the attestation of confirmed user_data: after it
   * changed, and otherwise at most once an hour.
   */
  async #attestUserData(): Promise<void> {
    const slot = this.#slot();
    const userId = this.#userId;
    if (
      !slot ||
      userId === undefined ||
      slot.state.status !== "ok" ||
      slot.rollback ||
      slot.stale ||
      this.#signingKeyMissing
    )
      return;
    const epoch = this.#epoch;
    if (!(await this.#freshnessSupported())) return;
    this.#current(epoch);
    const seq = seqOf(slot.state.raw);
    const now = this.#now();
    const last = this.#userDataAttested;
    if (last && last.seq >= seq && now - last.at < RENEW_AFTER_MS) return;
    const signed = this.#keys.useSigningKey((secretKey) =>
      signFreshness(
        {
          type: "user_data_freshness",
          userId,
          time: new Date(now).toISOString(),
          seq,
        },
        secretKey,
      ),
    );
    this.#userDataAttested = { at: now, seq };
    try {
      await this.#api.putUserDataFreshness(signed);
    } catch {
      this.#userDataAttested = undefined;
      return;
    }
    this.#current(epoch);
    await this.#confirmUserData(userId, slot);
  }

  /**
   * Makes a pairing for another device of this account: the vaults are
   * synced first, then their marks travel sealed with a one-time code.
   */
  async createPairing(): Promise<{ code: string; expiresAt: string }> {
    const epoch = this.#epoch;
    const userId = this.#requireUnlocked();
    if (!(await this.#freshnessSupported()))
      throw new SyncError("pairing_unsupported");
    await this.#engine?.refresh();
    this.#current(epoch);
    const marks = await this.#marks.read(userId);
    this.#current(epoch);
    const time = (ms: number | undefined) =>
      ms ? new Date(ms).toISOString() : null;
    const ids =
      this.#engine?.snapshot.vaults.map((v) => v.id) ??
      Object.keys(marks.vaults);
    const ud = marks.ud;
    const content: PairingContent = {
      fd: marks.fd ?? null,
      userData:
        ud && ud[0] >= 1 && ud[1] >= 1
          ? { rev: ud[0], seq: ud[1], at: time(marks.uf) }
          : null,
      vaults: ids.flatMap((vaultId) => {
        const m = marks.vaults[vaultId];
        return m
          ? [
              {
                vaultId,
                rev: m.rev,
                kv: m.kv ?? null,
                mf: m.mf ?? null,
                rl: m.rl ? { version: m.rl[0], hash: m.rl[1] } : null,
                at: time(m.ft),
              },
            ]
          : [];
      }),
    };
    const secret = generatePairingSecret(systemRandomness);
    try {
      const payload = sealPairing(systemRandomness, secret, userId, content);
      const { expiresAt } = await this.#api.putPairing(payload);
      this.#current(epoch);
      return { code: formatPairingCode(secret), expiresAt };
    } finally {
      wipe(secret);
    }
  }

  /**
   * Takes over the marks of another device of this account; afterwards
   * every vault and user_data are checked again against them.
   */
  async pair(code: string): Promise<{ vaults: number }> {
    const epoch = this.#epoch;
    const userId = this.#requireUnlocked();
    let secret: Uint8Array;
    try {
      secret = parsePairingCode(code);
    } catch {
      throw new SyncError("pairing_invalid");
    }
    try {
      if (!(await this.#freshnessSupported()))
        throw new SyncError("pairing_unsupported");
      let payload: string;
      try {
        payload = (await this.#api.pairing()).payload;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404)
          throw new SyncError("pairing_missing");
        throw error;
      }
      this.#current(epoch);
      let content: PairingContent;
      try {
        content = openPairing(secret, userId, payload);
      } catch (error) {
        if (error instanceof CryptoError) throw new SyncError("pairing_wrong");
        throw error;
      }
      const points = await this.#applyPairing(userId, content);
      this.#current(epoch);
      this.#newDevice = false;
      try {
        await this.#api.deletePairing();
      } catch {
        // It expires anyway.
      }
      this.#current(epoch);
      await this.reloadUserData();
      await this.#engine?.afterPairing(points);
      return { vaults: content.vaults.length };
    } finally {
      wipe(secret);
    }
  }

  /** The pairing's marks as floors; its confirmation times on this clock. */
  async #applyPairing(
    userId: string,
    content: PairingContent,
  ): Promise<Map<string, RolePoint>> {
    const now = this.#now();
    const time = (at: string | null) =>
      at === null ? 0 : (attestedAt(at, now) ?? 0);
    const vaults: UserMarks["vaults"] = {};
    const points = new Map<string, RolePoint>();
    for (const v of content.vaults) {
      vaults[v.vaultId] = {
        rev: v.rev,
        obj: {},
        ...(v.kv !== null ? { kv: v.kv } : {}),
        ...(v.mf !== null ? { mf: v.mf } : {}),
        ...(v.rl ? { rl: [v.rl.version, v.rl.hash] } : {}),
        ft: time(v.at),
      };
      if (v.rl) points.set(v.vaultId, v.rl);
    }
    const ud = content.userData;
    const uf = ud ? time(ud.at) : 0;
    await this.#marks.raise(userId, {
      ...(ud ? { ud: [ud.rev, ud.seq] } : {}),
      ...(uf > 0
        ? { uf, ...(content.fd !== null ? { fd: content.fd } : {}) }
        : {}),
      vaults,
    });
    return points;
  }

  // ------------------------------------------------------------ deletion

  /**
   * Deletes the account: local password check, reauth,
   * `DELETE /v1/me`, then the device forgets the account.
   */
  async deleteAccount(password: string): Promise<void> {
    const epoch = this.#epoch;
    const userId = this.#requireUnlocked();
    const check = await this.#checkPassword(password);
    this.#current(epoch);
    const reauthToken = await this.#api.reauth(check.authKey);
    this.#current(epoch);
    // Owners of vaults with a roles chain step down, signed, where others
    // own the vault too; the server refuses the deletion otherwise.
    await this.#engine?.stepDownEverywhere();
    this.#current(epoch);
    await this.#api.deleteMe(reauthToken);
    // What the device keeps about the deleted account goes in any case;
    // the session state only if no lock or other account came meanwhile.
    this.#memory.forget(userId);
    const current = epoch === this.#epoch;
    if (current) {
      this.lock();
      this.#userId = undefined;
      this.#email = undefined;
      this.#kdf = undefined;
    }
    await this.#marks.forgetUser(userId);
    if (!current) throw new AccountError("locked");
  }

  // ------------------------------------------------------------ two-factor

  /** The second factors of the account (`two_factor` of `GET /v1/me`). */
  async twoFactorStatus(): Promise<TwoFactorStatus> {
    const userId = this.#requireUnlocked();
    const me = await this.#api.me();
    if (me.user_id !== userId) throw new AccountError("integrity");
    return {
      totp: me.two_factor.totp,
      passkeys: me.two_factor.webauthn_credentials,
      backupCodesRemaining: me.two_factor.backup_codes_remaining,
    };
  }

  passkeys(): Promise<PasskeyInfo[]> {
    this.#requireUnlocked();
    return this.#api.passkeys();
  }

  /**
   * Master password (local check, then reauth), then a new TOTP secret to
   * show; `enable(code)` activates it.
   */
  async startTotpSetup(password: string): Promise<TotpSetup> {
    const reauthToken = await this.#reauthWith(password);
    const setup = await this.#api.totpSetup(reauthToken);
    return new TotpSetup(setup.secret, setup.otpauthUri, (code) =>
      this.#api.totpEnable(code),
    );
  }

  async disableTotp(password: string): Promise<void> {
    const reauthToken = await this.#reauthWith(password);
    await this.#api.totpDisable(reauthToken);
  }

  /** Ten new backup codes, shown once; the old ones become invalid. */
  async regenerateBackupCodes(password: string): Promise<string[]> {
    const reauthToken = await this.#reauthWith(password);
    return this.#api.regenerateBackupCodes(reauthToken);
  }

  /**
   * Options for `navigator.credentials.create`; `finish()` takes the
   * browser's `toJSON()`.
   */
  async startPasskeyRegistration(
    password: string,
    name: string,
  ): Promise<PasskeyRegistration> {
    const reauthToken = await this.#reauthWith(password);
    const options = await this.#api.webauthnRegisterOptions(reauthToken, name);
    return new PasskeyRegistration(options.publicKey, (credential) =>
      this.#api.webauthnRegisterVerify(options.registrationToken, credential),
    );
  }

  async removePasskey(password: string, id: string): Promise<void> {
    const reauthToken = await this.#reauthWith(password);
    await this.#api.deletePasskey(reauthToken, id);
  }

  /** Local password check, then a reauth token. */
  async #reauthWith(password: string): Promise<string> {
    const check = await this.#checkPassword(password);
    return this.#api.reauth(check.authKey);
  }

  // ------------------------------------------------------------ sessions

  sessions(): Promise<SessionInfo[]> {
    return this.#api.sessions();
  }

  revokeSession(sessionId: string): Promise<void> {
    return this.#api.revokeSession(sessionId);
  }

  revokeOtherSessions(): Promise<void> {
    return this.#api.revokeOtherSessions();
  }

  // ------------------------------------------------------------ helpers

  #requireUnlocked(): string {
    if (!this.#keys.isUnlocked) throw new AccountError("locked");
    return this.#keys.userId;
  }

  #derive(
    password: string,
    salt: Uint8Array,
    kdf: KdfParams,
  ): Promise<AccountKeys> {
    return deriveLoginKeysInWorker(this.#spawn, password, salt, kdf);
  }
}

interface SecondFactorSteps {
  api: ApiClient;
  now(): number;
  /** Unlocks with the session of a completed challenge. */
  complete(
    outcome: SecondFactorOutcome,
    key: Uint8Array,
  ): Promise<UnlockReport>;
  release(step: Discardable): void;
}

/**
 * The second step of a login. It holds only wrap_key,
 * until success, `discard()`, a challenge-ending answer, lock or the end
 * of the challenge's lifetime; the app also discards it on its own timer.
 */
export class SecondFactorLogin {
  readonly methods: readonly SecondFactorMethod[];
  /** Milliseconds since the epoch, by the account clock. */
  readonly expiresAt: number;
  readonly #token: string;
  readonly #steps: SecondFactorSteps;
  #wrapKey: Uint8Array | undefined;

  constructor(
    challenge: SecondFactorChallenge,
    wrapKey: Uint8Array,
    steps: SecondFactorSteps,
  ) {
    this.methods = challenge.methods;
    this.expiresAt = steps.now() + challenge.expiresIn * 1000;
    this.#token = challenge.token;
    this.#wrapKey = wrapKey;
    this.#steps = steps;
  }

  get isDiscarded(): boolean {
    return this.#wrapKey === undefined;
  }

  /** A wrong code (`invalid_second_factor`) keeps the step. */
  totp(code: string): Promise<UnlockReport> {
    return this.#complete((token) =>
      this.#steps.api.secondFactorTotp(token, code),
    );
  }

  backupCode(code: string): Promise<UnlockReport> {
    return this.#complete((token) =>
      this.#steps.api.secondFactorBackupCode(token, code),
    );
  }

  /** Options for `navigator.credentials.get`. */
  async passkeyOptions(): Promise<Record<string, unknown>> {
    this.#active();
    return this.#guard(() =>
      this.#steps.api.secondFactorWebauthnOptions(this.#token),
    );
  }

  /** `credential` is the browser's `PublicKeyCredential.toJSON()`. */
  passkey(credential: unknown): Promise<UnlockReport> {
    return this.#complete((token) =>
      this.#steps.api.secondFactorWebauthn(token, credential),
    );
  }

  discard(): void {
    if (this.#wrapKey) wipe(this.#wrapKey);
    this.#wrapKey = undefined;
    this.#steps.release(this);
  }

  async #complete(
    call: (token: string) => Promise<SecondFactorOutcome>,
  ): Promise<UnlockReport> {
    const wrapKey = this.#active();
    const outcome = await this.#guard(() => call(this.#token));
    try {
      const report = await this.#steps.complete(outcome, wrapKey);
      return outcome.backupCodesRemaining === undefined
        ? report
        : { ...report, backupCodesRemaining: outcome.backupCodesRemaining };
    } finally {
      this.discard();
    }
  }

  /** The key, or `challenge_expired` once the lifetime is over. */
  #active(): Uint8Array {
    const wrapKey = this.#wrapKey;
    if (!wrapKey || this.#steps.now() >= this.expiresAt) {
      this.discard();
      throw new AccountError("challenge_expired");
    }
    return wrapKey;
  }

  /** `challenge_invalid` and `account_disabled` end the step. */
  async #guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "challenge_invalid" ||
          error.code === "account_disabled")
      )
        this.discard();
      throw error;
    }
  }
}

export interface TwoFactorStatus {
  totp: boolean;
  passkeys: number;
  backupCodesRemaining: number;
}

type EnableTotp = (code: string) => Promise<string[] | undefined>;
type FinishPasskey = (
  credential: unknown,
) => Promise<{ id: string; backupCodes: string[] | undefined }>;

/** A TOTP setup of the own account: show, then confirm with a code. */
export class TotpSetup {
  /** Base32 without padding, for typing it into an app. */
  readonly secret: string;
  readonly otpauthUri: string;
  readonly #enable: EnableTotp;

  constructor(secret: string, otpauthUri: string, enable: EnableTotp) {
    this.secret = secret;
    this.otpauthUri = otpauthUri;
    this.#enable = enable;
  }

  /**
   * Activates TOTP; returns the backup codes if it is the first second
   * factor. `invalid_second_factor` allows another code.
   */
  enable(code: string): Promise<string[] | undefined> {
    return this.#enable(code);
  }
}

/** A passkey registration waiting for the browser's answer. */
export class PasskeyRegistration {
  /** `PublicKeyCredentialCreationOptionsJSON`. */
  readonly publicKey: Record<string, unknown>;
  readonly #finish: FinishPasskey;

  constructor(publicKey: Record<string, unknown>, finish: FinishPasskey) {
    this.publicKey = publicKey;
    this.#finish = finish;
  }

  /** Backup codes only if this is the first second factor. */
  finish(
    credential: unknown,
  ): Promise<{ id: string; backupCodes: string[] | undefined }> {
    return this.#finish(credential);
  }
}

interface RecoverySteps {
  api: ApiClient;
  now(): number;
  device: Device;
  derive(
    password: string,
    salt: Uint8Array,
    kdf: KdfParams,
  ): Promise<AccountKeys>;
  /** `authKey` of the new password, for the reauth of follow-up steps. */
  unlock(
    me: Me,
    userKey: Uint8Array,
    kdf: KdfParams,
    authKey: string,
  ): Promise<UnlockReport>;
  release(step: Discardable): void;
}

export type RecoveryStage = "second_factor" | "password" | "confirm" | "done";

/** What a step of the recovery leads to. */
export type RecoveryStep =
  | { stage: "password" | "second_factor" }
  | { stage: "done"; report: UnlockReport };

interface PreparedFinish {
  body: string;
  salt: string;
  userKeyWrapped: string;
  authKey: string;
  kdf: KdfParams;
  recoveryKey: string;
}

/**
 * A recovery with the recovery key: second factor if needed,
 * new master password, new recovery key, finish. It holds the recovery
 * wrap key during the second factor and then the unwrapped user key, until
 * it is done, discarded, ended by the server, locked or out of time.
 */
export class RecoveryProcess {
  readonly email: string;
  readonly #steps: RecoverySteps;
  #stage: RecoveryStage;
  #methods: readonly SecondFactorMethod[] = [];
  #challengeToken: string | undefined;
  /** The second factor after a lost finish is a login, not a recovery. */
  #relogin = false;
  #expiresAt: number;
  #recoveryWrapKey: Uint8Array | undefined;
  #userKey: Uint8Array | undefined;
  #userId: string | undefined;
  #recoveryToken: string | undefined;
  #prepared: PreparedFinish | undefined;
  /** A finish went out; from then on only the same body is sent. */
  #sent = false;

  constructor(
    email: string,
    recoveryWrapKey: Uint8Array,
    outcome: RecoverStartOutcome,
    steps: RecoverySteps,
  ) {
    this.email = email;
    this.#steps = steps;
    this.#recoveryWrapKey = recoveryWrapKey;
    if (outcome.kind === "second_factor") {
      this.#stage = "second_factor";
      this.#expiresAt = this.#challenge(outcome.challenge);
    } else {
      this.#stage = "password";
      this.#expiresAt = 0;
      this.#acceptPayload(outcome.payload);
    }
  }

  get stage(): RecoveryStage {
    return this.#stage;
  }

  /** Second factors offered in the stage `second_factor`. */
  get methods(): readonly SecondFactorMethod[] {
    return this.#methods;
  }

  /** End of the current challenge or of the recovery token (account clock). */
  get expiresAt(): number {
    return this.#expiresAt;
  }

  /** Display form of the new recovery key after `prepare()`. */
  get recoveryKey(): string | undefined {
    return this.#prepared?.recoveryKey;
  }

  get isDiscarded(): boolean {
    return this.#recoveryWrapKey === undefined && this.#userKey === undefined;
  }

  totp(code: string): Promise<RecoveryStep> {
    return this.#secondFactor((token) =>
      this.#steps.api.secondFactorTotp(token, code),
    );
  }

  backupCode(code: string): Promise<RecoveryStep> {
    return this.#secondFactor((token) =>
      this.#steps.api.secondFactorBackupCode(token, code),
    );
  }

  async passkeyOptions(): Promise<Record<string, unknown>> {
    const token = this.#secondFactorToken();
    return this.#guard(() =>
      this.#steps.api.secondFactorWebauthnOptions(token),
    );
  }

  passkey(credential: unknown): Promise<RecoveryStep> {
    return this.#secondFactor((token) =>
      this.#steps.api.secondFactorWebauthn(token, credential),
    );
  }

  /**
   * Builds the finish once and returns the new
   * recovery key to show and confirm. Before the first finish it may be
   * called again, e.g. with another password, and creates a new key.
   */
  async prepare(newPassword: string): Promise<string> {
    if (this.#sent || (this.#stage !== "password" && this.#stage !== "confirm"))
      throw new Error("Recovery is not waiting for a password");
    const userKey = this.#active();
    const userId = this.#userId ?? "";
    const prelogin = await this.#guard(() =>
      this.#steps.api.prelogin(this.email),
    );
    this.#still(userKey);
    let current: KdfParams;
    try {
      current = validateKdfParams(prelogin.kdf);
    } catch {
      throw new AccountError("kdf_invalid");
    }
    const setup = newPasswordSetup(systemRandomness, strongerOf(current));
    const keys = await this.#steps.derive(newPassword, setup.salt, setup.kdf);
    try {
      this.#still(userKey);
      const built = buildRecoveryFinish(
        systemRandomness,
        { userId, userKey, ...setup, loginKeys: keys },
        true,
      );
      this.#prepared = {
        body: JSON.stringify({
          recovery_token: this.#recoveryToken,
          ...built.request,
          device: this.#steps.device,
        }),
        salt: built.request.salt,
        userKeyWrapped: built.request.user_key_wrapped,
        authKey: built.request.auth_key,
        kdf: setup.kdf,
        recoveryKey: built.recoveryKeyDisplay ?? "",
      };
    } finally {
      wipe(keys.authKey, keys.wrapKey);
    }
    this.#stage = "confirm";
    return this.#prepared.recoveryKey;
  }

  /**
   * Sends the finish and unlocks. Network errors, 5xx and
   * 429 keep everything for an unchanged retry. A lost answer is found via
   * the salt; then the account logs in with the new password, and with a
   * second factor the stage goes back to `second_factor`.
   */
  async finish(): Promise<RecoveryStep> {
    const prepared = this.#prepared;
    if (this.#stage !== "confirm" || !prepared)
      throw new Error("Recovery is not prepared");
    this.#active();
    const first = !this.#sent;
    this.#sent = true;
    let session;
    try {
      session = await this.#steps.api.recoverFinish(prepared.body);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === "challenge_invalid" && !first)
        return this.#afterLostFinish(prepared, error);
      if (
        error.code === "challenge_invalid" ||
        error.code === "account_disabled" ||
        error.status === 400 ||
        error.status === 422
      )
        this.discard();
      throw error;
    }
    return this.#complete(session.userId);
  }

  discard(): void {
    if (this.#recoveryWrapKey) wipe(this.#recoveryWrapKey);
    if (this.#userKey) wipe(this.#userKey);
    this.#recoveryWrapKey = undefined;
    this.#userKey = undefined;
    this.#prepared = undefined;
    this.#steps.release(this);
  }

  /** The token was used: did an earlier finish arrive (new salt)? */
  async #afterLostFinish(
    prepared: PreparedFinish,
    original: ApiError,
  ): Promise<RecoveryStep> {
    const prelogin = await this.#steps.api.prelogin(this.email);
    if (prelogin.salt !== prepared.salt) {
      this.discard();
      throw original;
    }
    const outcome = await this.#steps.api.login({
      email: this.email,
      auth_key: prepared.authKey,
      device: this.#steps.device,
    });
    if (outcome.kind === "session") return this.#complete(outcome.userId);
    this.#relogin = true;
    this.#stage = "second_factor";
    this.#expiresAt = this.#challenge(outcome.challenge);
    return { stage: "second_factor" };
  }

  async #complete(sessionUserId: string): Promise<RecoveryStep> {
    const prepared = this.#prepared;
    const userKey = this.#userKey;
    if (!prepared || !userKey) throw new AccountError("challenge_expired");
    try {
      const me = await this.#steps.api.me();
      if (
        me.user_id !== this.#userId ||
        sessionUserId !== this.#userId ||
        me.salt !== prepared.salt ||
        me.user_key_wrapped !== prepared.userKeyWrapped
      )
        throw new AccountError("integrity");
      const report = await this.#steps.unlock(
        me,
        userKey.slice(),
        prepared.kdf,
        prepared.authKey,
      );
      this.#stage = "done";
      return { stage: "done", report };
    } finally {
      this.discard();
    }
  }

  #challenge(challenge: SecondFactorChallenge): number {
    this.#methods = challenge.methods;
    this.#challengeToken = challenge.token;
    return this.#steps.now() + challenge.expiresIn * 1000;
  }

  /** Opens the recovery-wrapped user key; a failure means the server lied. */
  #acceptPayload(payload: RecoveryPayload): void {
    const wrapKey = this.#recoveryWrapKey;
    if (!wrapKey) throw new AccountError("challenge_expired");
    try {
      this.#userKey = unwrapRecoveredUserKey(
        wrapKey,
        payload.userId,
        payload.userKeyRecoveryWrapped,
      );
    } catch {
      this.discard();
      throw new AccountError("integrity");
    } finally {
      wipe(wrapKey);
      this.#recoveryWrapKey = undefined;
    }
    this.#userId = payload.userId;
    this.#recoveryToken = payload.recoveryToken;
    this.#expiresAt = this.#steps.now() + payload.expiresIn * 1000;
    this.#stage = "password";
  }

  #secondFactorToken(): string {
    if (this.#stage !== "second_factor" || this.#challengeToken === undefined)
      throw new Error("Recovery is not waiting for a second factor");
    this.#active();
    return this.#challengeToken;
  }

  async #secondFactor(
    call: (token: string) => Promise<SecondFactorOutcome>,
  ): Promise<RecoveryStep> {
    const token = this.#secondFactorToken();
    const outcome = await this.#guard(() => call(token));
    if (this.#relogin) {
      if (outcome.kind !== "session") {
        this.discard();
        throw new AccountError("integrity");
      }
      return this.#complete(outcome.userId);
    }
    if (outcome.kind !== "recovery") {
      this.discard();
      throw new AccountError("integrity");
    }
    this.#acceptPayload(outcome.payload);
    return { stage: "password" };
  }

  /** Discarded meanwhile (lock, abort, expiry): the step ends here. */
  #still(userKey: Uint8Array): void {
    if (this.#userKey !== userKey) throw new AccountError("challenge_expired");
  }

  /** The key of the current stage; out of time ends the recovery. */
  #active(): Uint8Array {
    const key = this.#userKey ?? this.#recoveryWrapKey;
    const expired = !this.#sent && this.#steps.now() >= this.#expiresAt;
    if (!key || expired) {
      this.discard();
      throw new AccountError("challenge_expired");
    }
    return key;
  }

  /** `challenge_invalid` and `account_disabled` end the recovery. */
  async #guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.code === "challenge_invalid" ||
          error.code === "account_disabled")
      )
        this.discard();
      throw error;
    }
  }
}

interface RegistrationSteps {
  register(body: string): Promise<{ userId: string }>;
  loginWithBody(
    request: Registration["request"],
    material: AccountKeyMaterial,
  ): Promise<{ me: Me; userData: JsonObject | undefined }>;
  adopt(
    material: AccountKeyMaterial,
    data: {
      email: string;
      kdf: KdfParams;
      revision: number;
      userData: JsonObject | undefined;
    },
  ): Promise<void>;
}

/**
 * One registration attempt: the serialized request and the key
 * material stay in memory until the attempt succeeds or is discarded.
 */
export class PendingRegistration {
  /** Display form of the recovery key, shown after `submit()` succeeded. */
  readonly recoveryKey: string;
  readonly #body: string;
  readonly #request: Registration["request"];
  readonly #userData: JsonObject;
  readonly #steps: RegistrationSteps;
  #material: AccountKeyMaterial | undefined;
  #inFlight = false;

  constructor(
    body: string,
    registration: Registration,
    userData: JsonObject,
    steps: RegistrationSteps,
  ) {
    this.#body = body;
    this.#request = registration.request;
    this.#material = registration.account;
    this.recoveryKey = registration.recoveryKeyDisplay;
    this.#userData = userData;
    this.#steps = steps;
  }

  get isDiscarded(): boolean {
    return this.#material === undefined;
  }

  /**
   * Sends the request. Network errors, 5xx, 408 and 429 leave the attempt
   * ready for an unchanged retry; final errors discard it.
   */
  async submit(): Promise<void> {
    const material = this.#material;
    if (!material) throw new Error("Registration attempt was discarded");
    if (this.#inFlight) throw new Error("Registration already in progress");
    this.#inFlight = true;
    try {
      let revision = 1;
      let userData: JsonObject | undefined = this.#userData;
      try {
        await this.#steps.register(this.#body);
      } catch (error) {
        if (!(
          error instanceof ApiError && error.code === "already_registered"
        )) {
          if (
            error instanceof ApiError &&
            FINAL_REGISTRATION_CODES.has(error.code)
          )
            this.discard();
          throw error;
        }
        const existing = await this.#steps.loginWithBody(
          this.#request,
          material,
        );
        revision = existing.me.user_data.revision;
        userData = existing.userData;
      }
      try {
        await this.#steps.adopt(material, {
          email: this.#request.email,
          kdf: validateKdfParams(this.#request.kdf),
          revision,
          userData,
        });
      } catch (error) {
        // Overtaken by a lock: the keys go, the account exists anyway.
        this.discard();
        throw error;
      }
      this.#material = undefined;
    } finally {
      this.#inFlight = false;
    }
  }

  /** Gives up; the key material is wiped. */
  discard(): void {
    if (this.#material) wipe(this.#material.userKey, this.#material.privateKey);
    this.#material = undefined;
  }
}

interface RenewalSteps {
  put(reauthToken: string, body: string): Promise<void>;
  reauth(password: string): Promise<string>;
  confirmed(): Promise<void>;
}

/** A new recovery key that becomes valid with `commit()`. */
export class RecoveryKeyRenewal {
  readonly recoveryKey: string;
  readonly #body: string;
  readonly #steps: RenewalSteps;
  #reauthToken: string;

  constructor(
    recoveryKey: string,
    body: string,
    reauthToken: string,
    steps: RenewalSteps,
  ) {
    this.recoveryKey = recoveryKey;
    this.#body = body;
    this.#reauthToken = reauthToken;
    this.#steps = steps;
  }

  /** Replaces the recovery material; the old key stays valid until this succeeds. */
  async commit(): Promise<void> {
    try {
      await this.#steps.put(this.#reauthToken, this.#body);
    } catch (error) {
      if (error instanceof ApiError && error.code === "reauth_required")
        throw new AccountError("reauth_required");
      throw error;
    }
    await this.#steps.confirmed();
  }

  /** After `reauth_required`: new reauth token, then `commit()` again. */
  async reauthenticate(password: string): Promise<void> {
    this.#reauthToken = await this.#steps.reauth(password);
  }
}

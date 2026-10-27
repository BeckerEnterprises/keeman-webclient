/**
 * Freshness of the delivered state: the devices of an account confirm
 * what they see with signed attestations, and a vault counts as confirmed
 * only while this device, or another device of the account, confirmed it
 * within the period. Only the own account's attestations count; a removed
 * member could sign a fresh one for exactly the old state it still knows.
 * All times follow the device clock, never the server's.
 */
import type { ApiClient } from "../api/client";
import type { VaultSummary } from "../api/schemas";
import { CryptoError } from "../crypto/errors";
import {
  readFreshness,
  signFreshness,
  type UserDataFreshness,
  type VaultFreshness,
} from "../crypto/freshness";
import type { Keys } from "../crypto/keystore";
import type { RolePoint } from "../crypto/roles";
import type { Timers } from "./events";

export const DAY_MS = 86_400_000;
/** The period of a device that has not confirmed one yet. */
export const DEFAULT_PERIOD_DAYS = 7;
/** Attestations further in the future than this are ignored. */
export const FUTURE_TOLERANCE_MS = DAY_MS;
/** At most one upload per vault in this time. */
export const UPLOAD_SPACING_MS = 60_000;
/** A stored attestation older than this is renewed even without change. */
export const RENEW_AFTER_MS = 3_600_000;

export type FreshnessStatus = "fresh" | "stale";

/** The effective period in days: never longer than the confirmed one. */
export function effectivePeriodDays(
  setting: number,
  confirmed: number | undefined,
): number {
  return Math.min(setting, confirmed ?? DEFAULT_PERIOD_DAYS);
}

/** The own attestation of a vault, or `undefined` if it does not check out. */
export function ownVaultAttestation(
  signed: unknown,
  userId: string,
  vaultId: string,
  signingKey: Uint8Array,
): VaultFreshness | undefined {
  if (signed === null || signed === undefined) return undefined;
  try {
    const statement = readFreshness(signed, signingKey);
    return statement.type === "vault_freshness" &&
      statement.userId === userId &&
      statement.vaultId === vaultId
      ? statement
      : undefined;
  } catch {
    return undefined;
  }
}

/** The own attestation of `user_data`, or `undefined`. */
export function ownUserDataAttestation(
  signed: unknown,
  userId: string,
  signingKey: Uint8Array,
): UserDataFreshness | undefined {
  if (signed === null || signed === undefined) return undefined;
  try {
    const statement = readFreshness(signed, signingKey);
    return statement.type === "user_data_freshness" &&
      statement.userId === userId
      ? statement
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The time of an attestation on this device's clock: `undefined` if it lies
 * more than a day ahead, otherwise at most now.
 */
export function attestedAt(time: string, now: number): number | undefined {
  const at = Date.parse(time);
  if (!Number.isFinite(at) || at > now + FUTURE_TOLERANCE_MS) return undefined;
  return Math.min(at, now);
}

/** What the server delivered, as far as an attestation speaks about it. */
export interface DeliveredState {
  keyVersion: number;
  /** The delivered manifest root; `undefined` before a sync (not checked). */
  root?: { seq: number; hash: string } | null;
  /** Statements of the checked roles chain; `undefined` without a good one. */
  roles:
    readonly { statement: { version: number }; hash: string }[] | undefined;
}

/** Whether the delivered state is at least as new as the attestation. */
export function isSatisfied(
  attestation: VaultFreshness,
  delivered: DeliveredState,
): boolean {
  if (delivered.keyVersion < attestation.keyVersion) return false;
  const attested = attestation.manifest;
  if (attested && delivered.root !== undefined) {
    const root = delivered.root;
    if (
      !root ||
      root.seq < attested.seq ||
      (root.seq === attested.seq && root.hash !== attested.hash)
    )
      return false;
  }
  const point = attestation.roles;
  if (point) {
    if (!delivered.roles) return false;
    if (
      !delivered.roles.some(
        (s) => s.statement.version === point.version && s.hash === point.hash,
      )
    )
      return false;
  }
  return true;
}

/**
 * The later of the own confirmation and a satisfied attestation; `0` if
 * there is neither.
 */
export function confirmationBasis(
  confirmedAt: number,
  attestation: VaultFreshness | undefined,
  delivered: DeliveredState,
  now: number,
): number {
  const at =
    attestation && isSatisfied(attestation, delivered)
      ? (attestedAt(attestation.time, now) ?? 0)
      : 0;
  return Math.max(confirmedAt, at);
}

/** Whether a statement says more than another: a higher state. */
function isHigher(next: VaultFreshness, known: VaultFreshness): boolean {
  return (
    next.keyVersion > known.keyVersion ||
    (next.manifest?.seq ?? 0) > (known.manifest?.seq ?? 0) ||
    (next.roles?.version ?? 0) > (known.roles?.version ?? 0)
  );
}

export interface FreshnessPort {
  api: ApiClient;
  keys: Keys;
  userId: string;
  now(): number;
  timers: Timers;
  /** Whether the server stores attestations. */
  supported(): Promise<boolean>;
}

/**
 * The own attestations of the vaults: read from the vault list, uploaded at
 * most once a minute per vault, and only when they say something new or
 * the stored one is older than an hour.
 */
export class FreshnessKeeper {
  readonly #port: FreshnessPort;
  /** Verified own attestations from the last vault list. */
  readonly #listed = new Map<string, VaultFreshness>();
  /** The newest own attestation the server has, as far as known. */
  readonly #stored = new Map<string, VaultFreshness>();
  readonly #lastUpload = new Map<string, number>();
  readonly #timers = new Map<string, unknown>();
  readonly #builders = new Map<string, () => VaultFreshness | undefined>();
  /** Roles points this unlock learned from a pairing, by vault. */
  readonly #paired = new Map<string, RolePoint>();
  #stopped = false;

  constructor(port: FreshnessPort) {
    this.#port = port;
  }

  /** Reads the own attestations of the vault list; others are ignored. */
  take(summaries: readonly VaultSummary[]): Map<string, VaultFreshness> {
    const signingKey = this.#port.keys.signingPublicKey();
    this.#listed.clear();
    for (const summary of summaries) {
      if (summary.state !== "active") continue;
      const attestation = ownVaultAttestation(
        summary.freshness,
        this.#port.userId,
        summary.vault_id,
        signingKey,
      );
      if (!attestation) continue;
      this.#listed.set(summary.vault_id, attestation);
      const stored = this.#stored.get(summary.vault_id);
      if (!stored || Date.parse(stored.time) < Date.parse(attestation.time))
        this.#stored.set(summary.vault_id, attestation);
    }
    return new Map(this.#listed);
  }

  attestation(vaultId: string): VaultFreshness | undefined {
    return this.#listed.get(vaultId);
  }

  /** Roles points to check the chain against, besides the anchor. */
  rolePoints(vaultId: string): RolePoint[] {
    const points: RolePoint[] = [];
    const roles = this.#listed.get(vaultId)?.roles;
    if (roles) points.push(roles);
    const paired = this.#paired.get(vaultId);
    if (paired) points.push(paired);
    return points;
  }

  rememberPaired(vaultId: string, point: RolePoint): void {
    this.#paired.set(vaultId, point);
  }

  forgetPaired(vaultId: string): void {
    this.#paired.delete(vaultId);
  }

  /**
   * Offers the vault's attestation; `build` makes it at upload time and
   * returns `undefined` when the vault may not be signed (any more). The
   * returned promise ends after an immediate upload; a later one is timed.
   */
  async offer(
    vaultId: string,
    build: () => VaultFreshness | undefined,
  ): Promise<void> {
    if (this.#stopped || !(await this.#port.supported())) return;
    this.#builders.set(vaultId, build);
    const last = this.#lastUpload.get(vaultId);
    const now = this.#port.now();
    if (last === undefined || now - last >= UPLOAD_SPACING_MS) {
      await this.#upload(vaultId);
      return;
    }
    if (this.#timers.has(vaultId)) return;
    this.#timers.set(
      vaultId,
      this.#port.timers.setTimeout(
        () => {
          this.#timers.delete(vaultId);
          void this.#upload(vaultId);
        },
        last + UPLOAD_SPACING_MS - now,
      ),
    );
  }

  async #upload(vaultId: string): Promise<void> {
    if (this.#stopped) return;
    const statement = this.#builders.get(vaultId)?.();
    if (!statement) return;
    const stored = this.#stored.get(vaultId);
    const now = this.#port.now();
    if (
      stored &&
      !isHigher(statement, stored) &&
      now - (attestedAt(stored.time, now) ?? 0) < RENEW_AFTER_MS
    )
      return;
    let signed;
    try {
      signed = this.#port.keys.useSigningKey((secretKey) =>
        signFreshness(statement, secretKey),
      );
    } catch (error) {
      if (error instanceof CryptoError && error.code === "locked") return;
      throw error;
    }
    this.#lastUpload.set(vaultId, now);
    try {
      await this.#port.api.putVaultFreshness(vaultId, signed);
      this.#stored.set(vaultId, statement);
    } catch {
      // Not stored: the next sync offers it again.
    }
  }

  stop(): void {
    this.#stopped = true;
    for (const handle of this.#timers.values())
      this.#port.timers.clearTimeout(handle);
    this.#timers.clear();
    this.#builders.clear();
  }
}

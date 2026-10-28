/**
 * The roles chain of each vault on this device: loaded when the server
 * names another head, checked forward from the account's anchor, and the
 * anchor raised after every checked extension. Owners start a chain for
 * older vaults, drop owners who are no longer members and sign every role
 * change; pending keys are accepted only when the chain commits to them.
 */
import type { ApiClient } from "../api/client";
import { ApiError } from "../api/errors";
import type { Member } from "../api/schemas";
import { fromBase64Url } from "../crypto/bytes";
import { CryptoError } from "../crypto/errors";
import { fingerprint2Hex, fingerprintHex } from "../crypto/fingerprint";
import { derivePublicKey } from "../crypto/keypair";
import type { Keys } from "../crypto/keystore";
import {
  checkGrantRoles,
  checkRoleChain,
  genesisStatement,
  roleOwner,
  signRoleStatement,
  successorStatement,
  type DeliveredRoles,
  type GrantRolesRejection,
  type RoleOwner,
  type RolePoint,
  type SignedRoles,
  type VerifiedRoles,
} from "../crypto/roles";
import {
  comparisonPointsStatus,
  headCode,
  type StateCode,
} from "../crypto/state-code";
import type { Contact, RoleAnchor } from "../model/user-data";
import { keyOf, statusNow, toCandidate } from "../sharing/candidate";
import { contactStatus } from "../sharing/contacts";
import { SyncError } from "./errors";
import type { SyncMarks, UserMarks } from "./marks";

/** Attempts after `409 roles_conflict`. */
const MAX_ATTEMPTS = 3;

/**
 * `none`: the vault has no chain; `ok`: checked from the anchor;
 * `unanchored`: a chain this account has no anchor for yet and cannot take
 * over on its own; `unavailable`: the server names a chain that this
 * unlock could not check (it did not load, or ends below the named head),
 * which blocks like a warning but cannot be understood away; the others are
 * warnings.
 */
export type RolesStatus =
  | "none"
  | "ok"
  | "unanchored"
  | "unavailable"
  | "rollback"
  | "fork"
  | "invalid";

export interface VaultRoles {
  /** `roles_version` of the vault list the check is for. */
  readonly version: number | null;
  readonly status: RolesStatus;
  /** Authenticated statements of the last good check. */
  readonly statements: readonly VerifiedRoles[];
  readonly head: VerifiedRoles | undefined;
  /** The anchor the check started from. */
  readonly anchor: RoleAnchor | undefined;
  /**
   * Owners of the delivered head with the keys it names (also for
   * warnings), if it can be read.
   */
  readonly deliveredOwners: readonly RoleOwner[];
  /**
   * The delivered head as "understood" or "take over" would adopt it;
   * `null` for an empty chain, `undefined` if it cannot be read.
   */
  readonly deliveredHead?: RolePoint | null;
  /** Co-owners need to be verified before this owner can start a chain. */
  readonly verifyOwners: boolean;
  /** The comparison point behind a warning, if one is. */
  readonly compared?: {
    readonly kind: "mismatch" | "missing";
    readonly point: StateCode;
  };
  /** The state code of the checked head; only with status `ok`. */
  readonly code?: StateCode;
}

/** What the keeper needs from the account and the engine. */
export interface RolesPort {
  api: ApiClient;
  keys: Keys;
  userId: string;
  marks: SyncMarks;
  /** The anchor of a vault in user_data. */
  anchor(vaultId: string): RoleAnchor | undefined;
  /** Stores anchors in user_data (`null` removes one); best effort. */
  saveAnchors(anchors: Record<string, RoleAnchor | null>): Promise<void>;
  contacts(): readonly Contact[];
  /**
   * Further checked statements of a vault (own attestations, a confirmation by another device):
   * the highest of all points is the anchor, and the chain must agree with
   * every other one.
   */
  points?(vaultId: string): readonly RolePoint[];
  /** State codes members gave that contradicted; they only restrict. */
  comparisons?(vaultId: string, marks: UserMarks): readonly StateCode[];
}

function pointOf(head: VerifiedRoles): RolePoint {
  return { version: head.statement.version, hash: head.hash };
}

function anchorOfHead(head: VerifiedRoles): RoleAnchor {
  return {
    version: head.statement.version,
    hash: head.hash,
    owners: head.statement.owners.map((o) => o.userId),
  };
}

/** The higher of the account's anchor and the device's floor. */
function effectiveAnchor(
  stored: RoleAnchor | undefined,
  floor: [number, string] | undefined,
): { anchor: RoleAnchor | undefined; lower: RolePoint | undefined } {
  const fromFloor: RoleAnchor | undefined = floor
    ? { version: floor[0], hash: floor[1], owners: stored?.owners ?? [] }
    : undefined;
  if (!stored) return { anchor: fromFloor, lower: undefined };
  if (!fromFloor || fromFloor.version <= stored.version)
    return { anchor: stored, lower: fromFloor };
  return { anchor: fromFloor, lower: stored };
}

/** Whether a checked chain has the statement of a point. */
function holds(
  statements: readonly VerifiedRoles[],
  point: RolePoint,
): boolean {
  return statements.some(
    (s) => s.statement.version === point.version && s.hash === point.hash,
  );
}

/** Whether a delivered chain goes up to the head the server named. */
function reaches(
  statements: readonly DeliveredRoles[],
  version: number,
): boolean {
  return (statements[statements.length - 1]?.version ?? 0) >= version;
}

function samePoint(
  a: RolePoint | null | undefined,
  b: RolePoint | null | undefined,
): boolean {
  return (a ?? null)?.version === (b ?? null)?.version && a?.hash === b?.hash;
}

export class RolesKeeper {
  readonly #port: RolesPort;
  readonly #vaults = new Map<string, VaultRoles>();
  /** Delivered statements by vault, for the `roles_version` they belong to. */
  readonly #delivered = new Map<
    string,
    { version: number | null; statements: DeliveredRoles[] }
  >();
  /** Chains this unlock tried to start, and heads it tried to repair. */
  readonly #tried = new Set<string>();
  #pendingAnchors: Record<string, RoleAnchor | null> = {};
  #pendingFloors: Record<string, [number, string]> = {};

  constructor(port: RolesPort) {
    this.#port = port;
  }

  get(vaultId: string): VaultRoles | undefined {
    return this.#vaults.get(vaultId);
  }

  forget(vaultId: string): void {
    this.#vaults.delete(vaultId);
    this.#delivered.delete(vaultId);
  }

  async #load(
    vaultId: string,
    version: number | null,
  ): Promise<DeliveredRoles[]> {
    if (version === null) return [];
    const known = this.#delivered.get(vaultId);
    if (known && known.version === version) return known.statements;
    const statements = await this.#port.api.roles(vaultId, 0);
    // A chain that ends below the named head is not kept: the next update
    // loads it again.
    if (reaches(statements, version))
      this.#delivered.set(vaultId, { version, statements });
    return statements;
  }

  /**
   * A named chain this unlock cannot check. It never counts as "no chain":
   * the older owner rule would then accept a key from anyone the server
   * calls an owner.
   */
  unavailable(vaultId: string, version: number | null): VaultRoles {
    const previous = this.#vaults.get(vaultId);
    const result: VaultRoles = {
      version,
      status: "unavailable",
      statements: [],
      head: undefined,
      anchor: previous?.anchor,
      deliveredOwners: [],
      verifyOwners: previous?.verifyOwners ?? false,
    };
    this.#vaults.set(vaultId, result);
    return result;
  }

  /**
   * Loads the chain if the head changed and checks it. `owners` are the
   * owners this device remembers (for the transition of older vaults).
   */
  async update(
    vaultId: string,
    version: number | null,
    owners: readonly string[] | undefined,
  ): Promise<VaultRoles> {
    const previous = this.#vaults.get(vaultId);
    const points = this.#port.points?.(vaultId) ?? [];
    const marks = await this.#port.marks.read(this.#port.userId);
    const compared = this.#port.comparisons?.(vaultId, marks) ?? [];
    let delivered: DeliveredRoles[];
    try {
      delivered = await this.#load(vaultId, version);
    } catch (error) {
      if (error instanceof CryptoError && error.code === "locked") throw error;
      // Keep the last result with a chain; nothing is accepted on a stale
      // one. Points up to its head can still be checked against it.
      if (previous && previous.status !== "none")
        return previous.status === "unavailable"
          ? this.unavailable(vaultId, version)
          : this.#stillAgrees(vaultId, previous, points, compared);
      return this.unavailable(vaultId, version);
    }
    if (version !== null && !reaches(delivered, version))
      return this.unavailable(vaultId, version);
    const floor = marks.vaults[vaultId]?.rl;
    const stored = this.#port.anchor(vaultId);
    const effective = effectiveAnchor(stored, floor);
    let anchor = effective.anchor;
    const lower = effective.lower;
    const lowers = lower ? [lower] : [];
    for (const point of points) {
      if (!anchor || point.version > anchor.version) {
        if (anchor) lowers.push({ version: anchor.version, hash: anchor.hash });
        anchor = { ...point, owners: stored?.owners ?? [] };
      } else lowers.push(point);
    }
    // Two points of the same version with different hashes contradict.
    const fork = lowers.some(
      (l) =>
        anchor !== undefined &&
        l.version === anchor.version &&
        l.hash !== anchor.hash,
    );
    const roles = this.#check(vaultId, version, delivered, {
      anchor,
      lowers,
      fork,
      compared,
    });
    let result = roles;
    if (roles.status === "unanchored" && roles.head) {
      const adoptable = this.#adoptable(
        roles.head,
        roles.statements,
        owners ?? [],
      );
      if (adoptable === "invalid")
        result = {
          ...roles,
          status: "invalid",
          statements: [],
          head: undefined,
          code: undefined,
        };
      else if (adoptable) {
        this.#raise(vaultId, roles.head, stored);
        result = {
          ...roles,
          status: "ok",
          anchor: anchorOfHead(roles.head),
          code: headCode(roles.head),
        };
      }
    } else if (roles.status === "ok" && roles.head) {
      this.#raise(vaultId, roles.head, stored, floor);
    }
    this.#vaults.set(vaultId, {
      ...result,
      verifyOwners: previous?.verifyOwners ?? false,
    });
    return this.#vaults.get(vaultId) ?? result;
  }

  /** The last result, unless a point up to its head contradicts it. */
  #stillAgrees(
    vaultId: string,
    previous: VaultRoles,
    points: readonly RolePoint[],
    compared: readonly StateCode[],
  ): VaultRoles {
    const top = previous.head?.statement.version ?? 0;
    // Points above the last head are checked at the next load.
    const contradicted = points.some(
      (point) => point.version <= top && !holds(previous.statements, point),
    );
    const next = this.#compared(
      contradicted
        ? {
            ...previous,
            status: "fork",
            statements: [],
            head: undefined,
            code: undefined,
          }
        : previous,
      previous.statements,
      compared.filter((p) => p.version <= top),
    );
    if (next !== previous) this.#vaults.set(vaultId, next);
    return next;
  }

  /** Comparison points the chain does not satisfy make a warning. */
  #compared(
    roles: VaultRoles,
    statements: readonly VerifiedRoles[],
    points: readonly StateCode[],
  ): VaultRoles {
    if (
      roles.status !== "ok" &&
      roles.status !== "unanchored" &&
      roles.status !== "none"
    )
      return roles;
    const result = comparisonPointsStatus(statements, points);
    if (result.status === "ok") return roles;
    return {
      ...roles,
      status: result.status,
      statements: [],
      head: undefined,
      code: undefined,
      compared: {
        kind: result.status === "fork" ? "mismatch" : "missing",
        point: result.point,
      },
    };
  }

  #check(
    vaultId: string,
    version: number | null,
    delivered: DeliveredRoles[],
    against: {
      anchor: RoleAnchor | undefined;
      lowers: readonly RolePoint[];
      fork: boolean;
      compared: readonly StateCode[];
    },
  ): VaultRoles {
    const { anchor, lowers, fork, compared } = against;
    // Even with a warning the delivered head and its owners are shown.
    const plain = checkRoleChain({ vaultId, statements: delivered });
    const deliveredOwners =
      plain.status === "ok" ? plain.head.statement.owners : ([] as RoleOwner[]);
    const base = {
      version,
      statements: [] as VerifiedRoles[],
      head: undefined,
      anchor,
      deliveredOwners: [] as RoleOwner[],
      deliveredHead:
        plain.status === "ok"
          ? pointOf(plain.head)
          : plain.status === "empty"
            ? null
            : undefined,
      verifyOwners: false,
    };
    if (fork) return { ...base, status: "fork", deliveredOwners };
    const result = checkRoleChain({
      vaultId,
      statements: delivered,
      anchor: anchor
        ? { version: anchor.version, hash: anchor.hash }
        : undefined,
    });
    if (result.status === "empty")
      return this.#compared(
        { ...base, status: "none", deliveredOwners },
        [],
        compared,
      );
    if (result.status !== "ok")
      return { ...base, status: result.status, deliveredOwners };
    // Every lower point must be delivered as that very statement: a chain
    // that starts above it could hide a contradiction below the point the
    // check starts from.
    if (!lowers.every((l) => holds(result.statements, l)))
      return { ...base, status: "fork", deliveredOwners };
    return this.#compared(
      {
        ...base,
        status: anchor ? "ok" : "unanchored",
        statements: result.statements,
        head: result.head,
        deliveredOwners: result.head.statement.owners,
        ...(anchor ? { code: headCode(result.head) } : {}),
      },
      result.statements,
      compared,
    );
  }

  /**
   * Transition of a chain without anchor: taken over when its head was
   * signed by this account with its own keys, or by a remembered owner who
   * is a contact (verified, or checked before fingerprint version 2).
   * `invalid` when the head names this account with keys that are not its
   * own: a server could forge a chain in its name otherwise.
   */
  #adoptable(
    head: VerifiedRoles,
    statements: readonly VerifiedRoles[],
    owners: readonly string[],
  ): boolean | "invalid" {
    const { signer } = head.statement;
    const before =
      statements.find(
        (s) => s.statement.version === head.statement.version - 1,
      ) ?? head;
    const entry = before.statement.owners.find((o) => o.userId === signer);
    if (signer === this.#port.userId) {
      const own = this.#ownEntry();
      return entry?.publicKey === own.publicKey &&
        entry.signingKey === own.signingKey
        ? true
        : "invalid";
    }
    if (!owners.includes(signer)) return false;
    if (!entry) return false;
    const publicKey = fromBase64Url(entry.publicKey, 32);
    const status = contactStatus(this.#port.contacts(), signer, {
      v1: fingerprintHex(publicKey),
      v2: fingerprint2Hex(publicKey, fromBase64Url(entry.signingKey, 32)),
    });
    return status === "verified" || status === "outdated";
  }

  /** Queues the head as new anchor where it is newer than the stored one. */
  #raise(
    vaultId: string,
    head: VerifiedRoles,
    stored: RoleAnchor | undefined,
    floor?: [number, string],
  ): void {
    const version = head.statement.version;
    if (!stored || stored.version < version)
      this.#pendingAnchors[vaultId] = anchorOfHead(head);
    if (!floor || floor[0] < version)
      this.#pendingFloors[vaultId] = [version, head.hash];
  }

  /** Writes the anchors and floors queued by the last updates in one go. */
  async flush(): Promise<void> {
    const anchors = this.#pendingAnchors;
    const floors = this.#pendingFloors;
    this.#pendingAnchors = {};
    this.#pendingFloors = {};
    if (Object.keys(floors).length > 0)
      await this.#port.marks.raise(this.#port.userId, {
        vaults: Object.fromEntries(
          Object.entries(floors).map(([id, rl]) => [
            id,
            { rev: 0, obj: {}, rl },
          ]),
        ),
      });
    if (Object.keys(anchors).length > 0) await this.#port.saveAnchors(anchors);
  }

  /**
   * Takes the delivered head as anchor ("take over the owner list"), only
   * the head that was shown.
   */
  async confirm(
    vaultId: string,
    expected: { head: RolePoint | null },
  ): Promise<void> {
    const roles = this.#vaults.get(vaultId);
    if (roles?.status !== "unanchored" || !roles.head)
      throw new SyncError("not_found");
    if (!samePoint(pointOf(roles.head), expected.head))
      throw new SyncError("roles_changed");
    await this.#adopt(vaultId, roles.head);
  }

  /**
   * "Understood" at a roles warning: the delivered chain becomes the anchor,
   * also lowering the floor; it must be valid from its first statement and
   * be the head that was shown. `version` is the one the vault list names;
   * without it (a server without chains) the chain is empty. `before` runs
   * once everything is checked, before anything is written.
   */
  async acknowledge(
    vaultId: string,
    version: number | null | undefined,
    expected: { head: RolePoint | null },
    before?: () => Promise<void>,
  ): Promise<void> {
    if (this.#vaults.get(vaultId)?.status === "unavailable")
      throw new SyncError("roles_unavailable");
    const delivered =
      version === undefined || version === null
        ? []
        : this.#delivered.get(vaultId)?.statements;
    // Nothing loaded for a named chain: there is nothing to take over.
    if (delivered === undefined) throw new SyncError("roles_unavailable");
    const result = checkRoleChain({ vaultId, statements: delivered });
    if (result.status !== "ok" && result.status !== "empty")
      throw new SyncError("roles_invalid");
    const head = result.status === "ok" ? pointOf(result.head) : null;
    if (!samePoint(head, expected.head)) throw new SyncError("roles_changed");
    await before?.();
    if (result.status === "empty") {
      await this.#port.marks.replaceRoles(
        this.#port.userId,
        vaultId,
        undefined,
      );
      await this.#port.saveAnchors({ [vaultId]: null });
      return;
    }
    await this.#adopt(vaultId, result.head);
  }

  async #adopt(vaultId: string, head: VerifiedRoles): Promise<void> {
    await this.#port.marks.replaceRoles(this.#port.userId, vaultId, [
      head.statement.version,
      head.hash,
    ]);
    await this.#port.saveAnchors({ [vaultId]: anchorOfHead(head) });
  }

  /**
   * Whether a boxed key at `keyVersion` may be accepted: the chain checked
   * from the anchor must commit to it; `unchecked` without such a chain.
   */
  check(
    vaultId: string,
    keyVersion: number,
    opened: { vaultKey: Uint8Array; roles: RolePoint | undefined },
  ): GrantRolesRejection | "unchecked" | undefined {
    const roles = this.#vaults.get(vaultId);
    if (roles?.status !== "ok") return "unchecked";
    return checkGrantRoles({
      statements: roles.statements,
      roles: opened.roles,
      vaultId,
      keyVersion,
      vaultKey: opened.vaultKey,
    });
  }

  /**
   * The chain an invitee checks before accepting: valid from its first
   * statement; the inviter's box then vouches for it. `undefined` without a
   * chain.
   */
  async invitationChain(
    vaultId: string,
    version: number | null | undefined,
  ): Promise<readonly VerifiedRoles[] | undefined> {
    if (version === undefined || version === null) return undefined;
    const delivered = await this.#port.api.roles(vaultId, 0);
    // A named chain that is not delivered up to its head is not "no chain".
    if (!reaches(delivered, version)) throw new SyncError("roles_unavailable");
    const result = checkRoleChain({ vaultId, statements: delivered });
    if (result.status === "empty") return undefined;
    if (result.status !== "ok") throw new SyncError("roles_invalid");
    return result.statements;
  }

  /**
   * After an accepted invitation: the vouched chain's head becomes the
   * anchor. It replaces what the account knew before only where the user
   * accepted a contradiction; otherwise anchor and floor only rise.
   */
  async anchorInvitation(
    vaultId: string,
    statements: readonly VerifiedRoles[],
    replace: boolean,
  ): Promise<void> {
    const head = statements[statements.length - 1];
    if (!head) return;
    if (replace) {
      await this.#adopt(vaultId, head);
      return;
    }
    const marks = await this.#port.marks.read(this.#port.userId);
    this.#raise(
      vaultId,
      head,
      this.#port.anchor(vaultId),
      marks.vaults[vaultId]?.rl,
    );
    await this.flush();
  }

  /** The point a box names: the checked head. */
  point(vaultId: string): RolePoint | undefined {
    const roles = this.#vaults.get(vaultId);
    return roles?.status === "ok" && roles.head
      ? pointOf(roles.head)
      : undefined;
  }

  #ownEntry(): RoleOwner {
    return roleOwner(
      this.#port.userId,
      this.#publicKey(),
      this.#port.keys.signingPublicKey(),
    );
  }

  #publicKey(): Uint8Array {
    // pk' from the own private key, never the server's.
    return this.#port.keys.usePrivateKey(derivePublicKey);
  }

  #sign(statement: Parameters<typeof signRoleStatement>[0]): SignedRoles {
    return this.#port.keys.useSigningKey((secretKey) =>
      signRoleStatement(statement, secretKey),
    );
  }

  /**
   * Owners starting a chain for an older vault (all owners with verified
   * keys), and dropping owners of the head who are no longer members.
   * Best effort; once per vault and head in this unlock.
   */
  async ownerDuties(
    vaultId: string,
    keyVersion: number,
    members: readonly Member[] | undefined,
  ): Promise<boolean> {
    const roles = this.#vaults.get(vaultId);
    if (!roles || !this.#port.keys.hasVaultKey(vaultId, keyVersion))
      return false;
    const self = this.#port.userId;
    if (roles.status === "none") {
      const key = `start:${vaultId}`;
      if (this.#tried.has(key)) return false;
      const owners = (members ?? [])
        .filter((m) => m.role === "owner" && m.state === "active")
        .filter((m) => m.user_id !== self);
      const entries: RoleOwner[] = [this.#ownEntry()];
      for (const member of owners) {
        const candidate = toCandidate(member, this.#port.contacts(), self);
        const keys = keyOf(candidate);
        if (
          statusNow(candidate, this.#port.contacts()) !== "verified" ||
          !keys.signingKey
        ) {
          // Tried again once the contacts change.
          this.#vaults.set(vaultId, { ...roles, verifyOwners: true });
          return false;
        }
        entries.push(
          roleOwner(member.user_id, keys.publicKey, keys.signingKey),
        );
      }
      this.#tried.add(key);
      const signed = this.#port.keys.useVaultKey(vaultId, keyVersion, (vk) =>
        this.#sign(
          genesisStatement({
            vaultId,
            owners: entries,
            signer: self,
            keyVersion,
            vaultKey: vk,
            created: new Date().toISOString(),
          }),
        ),
      );
      return this.#append(vaultId, signed);
    }
    if (roles.status !== "ok" || !roles.head || !members) return false;
    const { head } = roles;
    if (!head.statement.owners.some((o) => o.userId === self)) return false;
    const active = new Set(
      members.filter((m) => m.state === "active").map((m) => m.user_id),
    );
    const staying = head.statement.owners.filter((o) => active.has(o.userId));
    if (staying.length === head.statement.owners.length) return false;
    const key = `repair:${vaultId}:${String(head.statement.version)}`;
    if (this.#tried.has(key)) return false;
    this.#tried.add(key);
    const signed = this.#sign(
      successorStatement(head, {
        owners: staying,
        signer: self,
        created: new Date().toISOString(),
      }),
    );
    return this.#append(vaultId, signed);
  }

  async #append(vaultId: string, signed: SignedRoles): Promise<boolean> {
    try {
      await this.#port.api.appendRoles(vaultId, signed);
      return true;
    } catch (error) {
      if (error instanceof CryptoError && error.code === "locked") throw error;
      return false;
    }
  }

  /**
   * The signed next statement for a role change: the head's owners with
   * `userId` added (a verified contact's checked keys) or removed. Retries
   * after `roles_conflict` with a reloaded chain.
   */
  async changeRole(
    vaultId: string,
    userId: string,
    role: "owner" | "member",
    send: (roles: SignedRoles | undefined) => Promise<void>,
    target?: { publicKey: Uint8Array; signingKey: Uint8Array },
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const roles = this.#vaults.get(vaultId);
      if (roles?.status !== "ok" || !roles.head)
        throw new SyncError("roles_invalid");
      const { head } = roles;
      const self = this.#port.userId;
      if (!head.statement.owners.some((o) => o.userId === self))
        throw new SyncError("read_only");
      const others = head.statement.owners.filter((o) => o.userId !== userId);
      let owners: RoleOwner[];
      if (role === "member") owners = others;
      else if (userId === self) owners = [...others, this.#ownEntry()];
      else {
        if (!target) throw new SyncError("unverified");
        owners = [
          ...others,
          roleOwner(userId, target.publicKey, target.signingKey),
        ];
      }
      // No owner would remain: the server answers `last_owner` before it
      // looks for a statement.
      const signed =
        owners.length === 0
          ? undefined
          : this.#sign(
              successorStatement(head, {
                owners,
                signer: self,
                created: new Date().toISOString(),
              }),
            );
      try {
        await send(signed);
        return;
      } catch (error) {
        if (
          !(error instanceof ApiError && error.code === "roles_conflict") ||
          attempt >= MAX_ATTEMPTS
        )
          throw error;
      }
      await this.reload(vaultId);
    }
  }

  /** Reloads the chain regardless of the version the vault list named. */
  async reload(vaultId: string): Promise<VaultRoles> {
    const statements = await this.#port.api.roles(vaultId, 0);
    const version = statements[statements.length - 1]?.version ?? null;
    this.#delivered.set(vaultId, { version, statements });
    const marks = await this.#port.marks.read(this.#port.userId);
    return this.update(vaultId, version, marks.vaults[vaultId]?.ow);
  }

  /**
   * The checked head and the owners after a rotation (the head's owners who
   * stay active members), reloaded after `roles_conflict`.
   */
  async rotationRoles(
    vaultId: string,
    members: readonly Member[],
    removed: ReadonlySet<string>,
    reload: boolean,
  ): Promise<{ head: VerifiedRoles; owners: RoleOwner[] } | undefined> {
    if (reload) await this.reload(vaultId);
    const roles = this.#vaults.get(vaultId);
    if (!roles || roles.status === "none") return undefined;
    if (roles.status !== "ok" || !roles.head)
      throw new SyncError("roles_invalid");
    const active = new Set(
      members
        .filter((m) => m.state === "active" && !removed.has(m.user_id))
        .map((m) => m.user_id),
    );
    active.add(this.#port.userId);
    const owners = roles.head.statement.owners.filter((o) =>
      active.has(o.userId),
    );
    return { head: roles.head, owners };
  }
}

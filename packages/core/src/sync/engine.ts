/**
 * Synchronisation of all vaults of the unlocked account: vault
 * list, sync per vault, events, writes, and a read-only projection for the
 * UI. Keys stay in the KeyStore; the projection never contains any.
 */
import type { ApiClient } from "../api/client";
import { ApiError } from "../api/errors";
import type { Member, PublicUser, VaultSummary } from "../api/schemas";
import { referencedAttachments, unreferenced } from "../attachments/refs";
import { fromBase64Url, type JsonObject } from "../crypto/bytes";
import { CryptoError } from "../crypto/errors";
import {
  buildVaultCreation,
  unwrapVaultKey,
  type NewObject,
} from "../crypto/flows/vault";
import { derivePublicKey } from "../crypto/keypair";
import type { Keys } from "../crypto/keystore";
import { checkGrantRoles, roleOwner, type RolePoint } from "../crypto/roles";
import { systemRandomness } from "../crypto/random";
import {
  applyEntryEdit,
  draftOf,
  newEntry,
  restoreEntrySnapshot,
  validateEntryDraft,
  withoutInvalidElements,
  type AttachmentInfo,
  type EntryDraft,
  type SaveContext,
} from "../model/entry";
import { EntryTooLarge } from "../model/history";
import {
  faviconTarget,
  iconHash,
  iconRefs,
  isIconPng,
  newIcon,
  renameIconRefs,
  type IconSource,
} from "../model/icon";
import { clone, same, setOwn } from "../model/json";
import { isManifestId, manifestIds } from "../model/manifest";
import type { VaultFreshness } from "../crypto/freshness";
import { keyAtEnd, keysAtEnd } from "../model/sort-key";
import { ancestors, subtree } from "../model/tree";
import {
  applyObjectChange,
  newGroup,
  newVaultMeta,
  normalizeName,
  timestampOf,
  type IconRef,
  type Stamp,
} from "../model/vault";
import {
  attachKdbxBinaries,
  buildKdbxExport,
  KDBX_EXPORT_ATTACHMENT_BYTES,
  type KdbxExportReport,
  type KdbxSkipped,
} from "../kdbx/export";
import { planKdbxImport } from "../kdbx/plan";
import type { KdbxExportModel, KdbxFile, KdbxTimes } from "../kdbx/types";
import { SearchIndex, type SearchQuery } from "../search/index";
import { searchTerms } from "../search/normalize";
import type { Contact, RoleAnchor } from "../model/user-data";
import {
  keyOf,
  statusNow,
  toCandidate,
  type Candidate,
} from "../sharing/candidate";
import { acceptGrant, grantName, type RolesCheck } from "../sharing/grants";
import {
  decline,
  invite,
  leave,
  lookup,
  memberViews,
  setRole,
  withdraw,
  type MemberView,
} from "../sharing/members";
import {
  prepareRotation,
  runRotation,
  type RotationDecisions,
  type RotationReview,
} from "../sharing/rotation";
import { SyncError } from "./errors";
import { resolveUrl, type ResolvedUrl } from "../placeholders/resolve";
import { totpFromUri, type TotpResult } from "../totp/code";
import { TotpClock } from "../totp/clock";
import {
  EventClient,
  systemTimers,
  type ConnectionState,
  type ServerEvent,
  type SocketFactory,
  type Timers,
} from "./events";
import {
  Attachments,
  type AttachmentFile,
  type AttachmentRun,
  type PreparedUpload,
} from "./attachments";
import { IdMap } from "./id-map";
import { KdbxImportJob, type KdbxImportPort } from "./kdbx-import";
import type { SyncMarks, UserMarks } from "./marks";
import {
  attestedAt,
  confirmationBasis,
  DAY_MS,
  FreshnessKeeper,
  RENEW_AFTER_MS,
  type DeliveredState,
} from "./freshness";
import { currentRoot } from "./manifest";
import { RolesKeeper } from "./roles";
import { Serial } from "./serial";
import {
  basesOf,
  brokenReferences,
  byBucket,
  checkMove,
  chunks,
  deletePlan,
  destroyIntents,
  isGroupNode,
  layoutOf,
  manifestCost,
  metaOf,
  newRootIntents,
  planMove,
  planNewGroup,
  planRestore,
  planTrash,
  repairIntents,
  type DeletePlan,
  type GroupProps,
  type ItemRef,
  type MoveCheck,
  type MoveTarget,
  type Ops,
} from "./tree-ops";
import {
  acknowledgeRollback,
  pullVault,
  VaultState,
  type SyncContext,
} from "./vault";
import {
  usedIcons,
  VaultProjection,
  type EntryDetail,
  type EntrySummary,
  type SyncSnapshot,
  type VaultView,
} from "./views";
import {
  isTransient,
  objectWritable,
  RetryableWrite,
  vaultWritable,
  WriteOperation,
  type Intent,
  type ManifestMode,
  type Notice,
  type Pending,
  type Plan,
  type WriteResult,
} from "./writer";

export type { Notice, WriteResult } from "./writer";
export type {
  KdbxImportJob,
  KdbxImportProgress,
  KdbxImportRun,
} from "./kdbx-import";
export type {
  DeletePlan,
  GroupProps,
  ItemRef,
  MoveBlock,
  MoveCheck,
  MoveTarget,
} from "./tree-ops";
export type {
  CorruptObjectView,
  InvitationView,
  EntryDetail,
  EntrySummary,
  EntryValues,
  HistoryItem,
  IconView,
  ResolvedValues,
  SyncSnapshot,
  TreeNode,
  TreeNodeProblem,
  VaultTree,
  VaultView,
} from "./views";

export interface SyncEngineOptions {
  /** Opens a WebSocket; without it the engine syncs on demand only. */
  socket?: SocketFactory;
  /** The session was revoked or became invalid. */
  onSessionEnded?: () => void;
  /** `user_data` changed on another device and was reloaded. */
  onUserDataChanged?: () => void;
  /** Page size of `changes`. */
  pageLimit?: number;
  timers?: Timers;
}

/** What the engine needs from the account; not part of the public API. */
export interface AccountAccess {
  api: ApiClient;
  keys: Keys;
  userId: string;
  marks: SyncMarks;
  vaultOrder(): string[];
  setVaultOrder(ids: string[]): Promise<void>;
  /** Local password check and reauth; a reauth token. */
  reauth(password: string): Promise<string>;
  reloadUserData(revision: number): Promise<void>;
  /** Contacts that count; empty while user_data is unreadable. */
  contacts(): readonly Contact[];
  /** The roles anchor of a vault in user_data; none while it is unreadable. */
  roleAnchor(vaultId: string): RoleAnchor | undefined;
  /** Stores roles anchors in user_data (`null` removes one); best effort. */
  saveRoleAnchors(anchors: Record<string, RoleAnchor | null>): Promise<void>;
  /** The device clock (Unix ms); never the server's time. */
  now(): number;
  /** The effective confirmation period in days. */
  freshnessPeriodDays(): number;
  /** Signs and uploads the attestation of user_data where it is confirmed. */
  attestUserData(): Promise<void>;
}

/** A pending invitation as the engine keeps it. */
interface Invitation {
  summary: VaultSummary;
  sender: PublicUser | undefined;
  vaultName: string | undefined;
}

/** Where a KDBX import goes. */
export type KdbxImportTarget =
  | { kind: "vault"; name: string }
  | { kind: "group"; vaultId: string; groupId: string };

export interface NewVaultNames {
  name: string;
  rootName: string;
  recycleBinName: string;
}

/** Vault metadata a user may change. */
export interface VaultChange {
  name?: string;
  description?: string;
  color?: string | null;
  icon?: IconRef | null;
  recycleBinEnabled?: boolean;
  historyMaxItems?: number;
}

/** An entry as the editor started it; the base of a later save. */
export class EntryBase {
  readonly vaultId: string;
  readonly entryId: string;
  readonly revision: number;

  constructor(vaultId: string, entryId: string, revision: number) {
    this.vaultId = vaultId;
    this.entryId = entryId;
    this.revision = revision;
  }
}

// The decrypted base stays out of reach of the app.
const baseRaws = new WeakMap<EntryBase, Record<string, unknown>>();

const MAX_PARALLEL_PULLS = 2;

function stamp(userId: string): Stamp {
  return { now: new Date().toISOString(), userId };
}

function noChange(): WriteResult {
  return { notices: [] };
}

export class SyncEngine {
  readonly #access: AccountAccess;
  readonly #options: SyncEngineOptions;
  readonly #context: SyncContext;
  readonly #states = new Map<string, VaultState>();
  readonly #projections = new Map<string, VaultProjection>();
  readonly #listeners = new Set<(snapshot: SyncSnapshot) => void>();
  readonly #refreshSerial = new Serial();
  readonly #events: EventClient | undefined;
  readonly #clock: TotpClock;
  readonly #search = new SearchIndex();
  readonly #attachments: Attachments;
  #collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  #stopped = false;
  #loaded = false;
  #connection: ConnectionState = "offline";
  #marksLimited = false;
  #error: unknown = undefined;
  #snapshot: SyncSnapshot | undefined;
  #notifying = false;
  #pulls = 0;
  readonly #waiting: (() => void)[] = [];
  #invitations: Invitation[] = [];
  /** Public keys of senders by account; `null`: the server names none. */
  readonly #publicUsers = new Map<string, PublicUser | null>();
  /** Whether the server knows the vault manifest, asked once. */
  #manifestFeature: Promise<boolean> | undefined;
  /** Vaults whose manifest this unlock tried to create. */
  readonly #manifestTried = new Set<string>();
  /** Whether the server knows signing keys and roles chains, asked once. */
  #rolesFeature: Promise<boolean> | undefined;
  readonly #roles: RolesKeeper;
  /** Whether the server stores freshness attestations, asked once. */
  #freshnessFeature: Promise<boolean> | undefined;
  readonly #freshness: FreshnessKeeper;
  /** The hourly refresh while unlocked. */
  #tick: unknown;

  constructor(access: AccountAccess, options: SyncEngineOptions = {}) {
    this.#access = access;
    this.#options = options;
    this.#attachments = new Attachments(access.api);
    const marks = access.marks;
    const track = (ok: boolean): boolean => {
      if (!ok && !this.#marksLimited) {
        this.#marksLimited = true;
        this.#emit();
      }
      return ok;
    };
    this.#context = {
      api: access.api,
      keys: access.keys,
      userId: access.userId,
      pageLimit: options.pageLimit,
      marks: {
        read: (userId) => marks.read(userId),
        raise: async (userId, m) => track(await marks.raise(userId, m)),
        replaceVault: async (userId, id, m) =>
          track(await marks.replaceVault(userId, id, m)),
        replaceUserData: async (userId, ud) =>
          track(await marks.replaceUserData(userId, ud)),
        rememberOwners: async (userId, id, owners) =>
          track(await marks.rememberOwners(userId, id, owners)),
        replaceRoles: async (userId, id, rl) =>
          track(await marks.replaceRoles(userId, id, rl)),
        forgetVault: (userId, id) => marks.forgetVault(userId, id),
        forgetUser: (userId) => marks.forgetUser(userId),
      },
    };
    this.#roles = new RolesKeeper({
      api: access.api,
      keys: access.keys,
      userId: access.userId,
      marks: this.#context.marks,
      anchor: (vaultId) => access.roleAnchor(vaultId),
      saveAnchors: (anchors) => access.saveRoleAnchors(anchors),
      contacts: () => access.contacts(),
    });
    this.#freshness = new FreshnessKeeper({
      api: access.api,
      keys: access.keys,
      userId: access.userId,
      now: () => access.now(),
      timers: options.timers ?? systemTimers,
      supported: () => this.#freshnessSupported(),
    });
    this.#clock = new TotpClock({
      time: () => access.api.time(),
      timers: options.timers ?? systemTimers,
      onChange: () => {
        this.#emit();
      },
    });
    if (options.socket) {
      this.#events = new EventClient({
        url: access.api.eventsUrl,
        socket: options.socket,
        token: () => access.api.socketToken(),
        refresh: async () => {
          try {
            await access.api.refresh();
            return true;
          } catch (error) {
            return !(error instanceof ApiError && error.status === 401);
          }
        },
        onReady: () => {
          void this.refresh();
        },
        onEvent: (event) => {
          this.#onEvent(event);
        },
        onState: (state) => {
          this.#connection = state;
          this.#emit();
        },
        onSessionEnded: () => {
          this.#options.onSessionEnded?.();
        },
        timers: options.timers,
      });
    }
  }

  /** The current projection; built on access after changes. */
  get snapshot(): SyncSnapshot {
    this.#snapshot ??= this.#build();
    return this.#snapshot;
  }

  subscribe(listener: (snapshot: SyncSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Names are sorted in the language of the UI. */
  setCollation(locale: string): void {
    this.#collator = new Intl.Collator(locale, {
      numeric: true,
      sensitivity: "base",
    });
    this.#emit();
  }

  /** Loads the vault list and syncs; connects the WebSocket. */
  async start(): Promise<void> {
    this.#events?.start();
    this.#clock.start();
    this.#scheduleTick();
    await this.refresh();
  }

  /** On lock or logout: closes the WebSocket and drops the state. */
  stop(): void {
    this.#stopped = true;
    this.#events?.stop();
    this.#clock.stop();
    this.#freshness.stop();
    if (this.#tick !== undefined)
      (this.#options.timers ?? systemTimers).clearTimeout(this.#tick);
    this.#tick = undefined;
    this.#attachments.stop();
    this.#states.clear();
    this.#projections.clear();
    this.#listeners.clear();
  }

  /** Online again or tab visible: reconnect now and sync. */
  nudge(): void {
    if (this.#stopped) return;
    this.#events?.nudge();
    void this.refresh();
  }

  /** `GET /v1/vaults`, then a sync of every vault that changed. */
  refresh(): Promise<void> {
    return this.#refreshSerial.run(async () => {
      try {
        await this.#refresh();
      } catch (error) {
        // A lock stopped the engine while it waited; its keys are gone.
        if (
          this.#isStopped() &&
          error instanceof CryptoError &&
          error.code === "locked"
        )
          return;
        throw error;
      }
    });
  }

  /** Delta sync of one vault. */
  async pull(vaultId: string): Promise<void> {
    const state = this.#states.get(vaultId);
    if (!state || this.#stopped) return;
    await state.serialize(() =>
      state.lock.run(() =>
        this.#limit(async () => {
          try {
            await pullVault(this.#context, state);
            state.error = undefined;
            this.#evaluate(state);
          } catch (error) {
            if (this.#stopped) return;
            if (error instanceof CryptoError && error.code === "locked") return;
            state.error = error;
          }
        }),
      ),
    );
    this.#emit();
    await this.#attest(state);
    if (state.manifest.status === "unverified")
      void this.#ensureManifest(state);
  }

  /**
   * Creates the manifest of a vault that has none, in a batch of its own:
   * once per unlock and vault, only if the server knows it. A failure
   * leaves the vault unverified.
   */
  async #ensureManifest(state: VaultState): Promise<void> {
    if (
      this.#stopped ||
      state.manifest.status !== "unverified" ||
      this.#manifestTried.has(state.id) ||
      !vaultWritable(state)
    )
      return;
    this.#manifestTried.add(state.id);
    if (!(await this.#manifestSupported())) return;
    const plan: Plan = (current) => {
      const meta = current.meta;
      if (!meta) return [];
      return [
        {
          kind: "update",
          id: meta.id,
          baseRaw: meta.raw,
          baseRevision: meta.revision,
          local: applyObjectChange(
            meta.raw,
            { manifest: true },
            stamp(this.#access.userId),
          ),
        },
      ];
    };
    try {
      await state.lock.run(() => this.#operation(state, plan, "create").run());
    } catch {
      // Stays unverified; the next unlock tries again.
    }
    this.#emit();
  }

  #manifestSupported(): Promise<boolean> {
    this.#manifestFeature ??= this.#access.api.config().then(
      (config) => config.features.manifest === true,
      () => false,
    );
    return this.#manifestFeature;
  }

  #rolesSupported(): Promise<boolean> {
    this.#rolesFeature ??= this.#access.api.config().then(
      (config) => config.features.roles === true,
      () => false,
    );
    return this.#rolesFeature;
  }

  #operation(
    state: VaultState,
    plan: Plan,
    mode: ManifestMode = "update",
  ): WriteOperation {
    return new WriteOperation(
      this.#context,
      state,
      plan,
      async () => {
        await pullVault(this.#context, state);
        this.#evaluate(state);
        void this.#attest(state).catch(() => undefined);
      },
      () => new Date().toISOString(),
      mode,
    );
  }

  // ------------------------------------------------------------ vaults

  /** A new vault with root group and recycle bin. */
  async createVault(names: NewVaultNames): Promise<string> {
    const name = normalizeName(names.name);
    const rootName = normalizeName(names.rootName);
    const binName = normalizeName(names.recycleBinName);
    if (!name || !rootName || !binName) throw new SyncError("invalid_name");
    const now = stamp(this.#access.userId);
    return this.#createVault([
      {
        label: "meta",
        type: "vault_meta",
        content: (ids) =>
          newVaultMeta(
            {
              name,
              rootGroupId: ids.root ?? "",
              recycleBinGroupId: ids.bin ?? "",
            },
            now,
          ),
      },
      {
        label: "root",
        type: "group",
        content: newGroup({ name: rootName, parentId: null }, now),
      },
      {
        label: "bin",
        type: "group",
        content: (ids) =>
          newGroup(
            {
              name: binName,
              parentId: ids.root ?? null,
              sortKey: "a0",
              icon: { type: "builtin", name: "trash-2" },
            },
            now,
          ),
      },
    ]);
  }

  /**
   * `POST /v1/vaults`, with the manifest if the server knows it; a network
   * error's `retry` sends the same bytes.
   */
  async #createVault(objects: NewObject[]): Promise<string> {
    const access = this.#access;
    const manifest = await this.#manifestSupported();
    const flagged = objects.map((object): NewObject => {
      const { content } = object;
      if (!manifest || object.type !== "vault_meta") return object;
      const withFlag = (raw: JsonObject): JsonObject => {
        const copy = clone(raw);
        setOwn(copy, "manifest", true);
        return copy;
      };
      return {
        ...object,
        content:
          typeof content === "function"
            ? (ids) => withFlag(content(ids))
            : withFlag(content),
      };
    });
    const roles = await this.#rolesSupported();
    const creation = access.keys.useUserKey((userKey) =>
      access.keys.useSigningKey((signingSecretKey) =>
        buildVaultCreation(systemRandomness, {
          userId: access.userId,
          userKey,
          objects: flagged,
          manifest,
          ...(roles
            ? {
                roles: {
                  owner: roleOwner(
                    access.userId,
                    access.keys.usePrivateKey(derivePublicKey),
                    access.keys.signingPublicKey(),
                  ),
                  signingSecretKey,
                  created: new Date().toISOString(),
                },
              }
            : {}),
        }),
      ),
    );
    const vaultId = creation.vaultId;
    access.keys.setVaultKey(vaultId, 1, creation.vaultKey);
    // A vault this device creates is confirmed from the start.
    await this.#context.marks.raise(access.userId, {
      vaults: { [vaultId]: { rev: 0, obj: {}, ft: access.now() } },
    });
    const key = systemRandomness.id("idempotency_key");
    const body = JSON.stringify(creation.request);
    const send = async (): Promise<string> => {
      try {
        await access.api.createVault(key, body);
      } catch (error) {
        if (isTransient(error)) throw new SyncError("network", send);
        // After more than 24 h a repetition meets the existing vault.
        const mine =
          error instanceof ApiError &&
          error.code === "conflict" &&
          (await access.api.vaults()).some(
            (v) => v.vault_id === vaultId && v.role === "owner",
          );
        if (!mine) {
          access.keys.forgetVault(vaultId);
          throw error;
        }
      }
      await this.refresh();
      return vaultId;
    };
    return send();
  }

  // ------------------------------------------------------------ sharing

  /**
   * The contacts changed (verified, removed, merged): statuses are computed
   * again, and pending keys of newly verified senders are accepted.
   */
  contactsChanged(): void {
    this.#emit();
    void this.refresh();
  }

  /** An account by e-mail address with its fingerprint. */
  lookupUser(email: string): Promise<Candidate> {
    return lookup(this.#access, email);
  }

  /**
   * Members and invitations of a vault with their status; with a checked
   * roles chain the roles come from it.
   */
  async members(vaultId: string): Promise<MemberView[]> {
    const state = this.#state(vaultId);
    const views = await memberViews(this.#access, vaultId);
    const head = state.roles?.status === "ok" ? state.roles.head : undefined;
    if (!head) return views;
    const owners = new Set(head.statement.owners.map((o) => o.userId));
    return views.map((view) =>
      view.state !== "active"
        ? view
        : {
            ...view,
            role: owners.has(view.userId) ? "owner" : "member",
            signed: true,
            roleMismatch: (view.role === "owner") !== owners.has(view.userId),
          },
    );
  }

  /**
   * The roles chain of an owned vault before a change: started first where
   * the vault has none yet (`undefined` if that is not possible); a warning
   * blocks.
   */
  async #ensureRoles(
    state: VaultState,
  ): Promise<{ version: number; hash: string } | undefined> {
    let roles = state.roles;
    if (!(await this.#rolesSupported()) || !roles) return undefined;
    if (roles.status === "none") {
      const members =
        state.members ?? (await this.#access.api.members(state.id));
      const started = await this.#roles.ownerDuties(
        state.id,
        state.summary.vault_key_version,
        members,
      );
      if (started) roles = state.roles = await this.#roles.reload(state.id);
      await this.#roles.flush();
    }
    if (roles.status === "none") return undefined;
    const point = this.#roles.point(state.id);
    if (!point) throw new SyncError("roles_invalid");
    return point;
  }

  /** Takes over the delivered owner list of a vault without anchor. */
  async confirmRoles(vaultId: string): Promise<void> {
    this.#state(vaultId);
    await this.#roles.confirm(vaultId);
    await this.refresh();
  }

  /** "Understood" at a warning about the owner list of a vault. */
  async acknowledgeRoles(vaultId: string): Promise<void> {
    this.#state(vaultId);
    await this.#roles.acknowledge(vaultId);
    await this.refresh();
  }

  /**
   * Before the account is deleted: steps down as owner, signed, wherever
   * others own the vault too.
   */
  async stepDownEverywhere(): Promise<void> {
    const self = this.#access.userId;
    for (const state of this.#states.values()) {
      const head = state.roles?.status === "ok" ? state.roles.head : undefined;
      if (state.summary.role !== "owner" || !head) continue;
      const owners = head.statement.owners.map((o) => o.userId);
      if (!owners.includes(self) || owners.length < 2) continue;
      await this.#roles.changeRole(state.id, self, "member", (roles) =>
        setRole(this.#access, state.id, self, "member", roles),
      );
    }
    await this.refresh();
  }

  #owned(vaultId: string): VaultState {
    const state = this.#state(vaultId);
    if (state.summary.role !== "owner" || state.keyStatus !== "ok")
      throw new SyncError("read_only");
    return state;
  }

  #vaultName(state: VaultState): string {
    return this.#projection(state).view(state, this.#collator).name ?? "";
  }

  /** Invites a verified contact; the box vouches for the checked roles. */
  async invite(vaultId: string, candidate: Candidate): Promise<void> {
    const state = this.#owned(vaultId);
    // With an unconfirmed state the old key might be handed on.
    this.#requireConfirmed(state);
    const roles = await this.#ensureRoles(state);
    const root = currentRoot(state);
    await invite(
      this.#access,
      {
        vaultId,
        keyVersion: state.summary.vault_key_version,
        vaultName: this.#vaultName(state),
        roles,
        manifest:
          state.manifest.status === "verified" && root
            ? root.entry.seq
            : undefined,
      },
      candidate,
    );
    await this.refresh();
  }

  async withdrawInvitation(vaultId: string, userId: string): Promise<void> {
    this.#owned(vaultId);
    await withdraw(this.#access, vaultId, userId);
    await this.refresh();
  }

  /**
   * Changes a role; with a roles chain the next statement is signed, and a
   * promotion needs a verified contact (fingerprint version 2).
   */
  async setMemberRole(
    vaultId: string,
    userId: string,
    role: "owner" | "member",
  ): Promise<void> {
    const state = this.#owned(vaultId);
    const access = this.#access;
    // Stepping down needs no confirmed state; everything else does.
    if (!(userId === access.userId && role === "member"))
      this.#requireConfirmed(state);
    if (!(await this.#ensureRoles(state))) {
      await setRole(access, vaultId, userId, role);
      await this.refresh();
      return;
    }
    let target: { publicKey: Uint8Array; signingKey: Uint8Array } | undefined;
    if (role === "owner" && userId !== access.userId) {
      const member = (await access.api.members(vaultId)).find(
        (m) => m.user_id === userId && m.state === "active",
      );
      if (!member) throw new SyncError("not_found");
      const candidate = this.#candidate(member);
      const keys = keyOf(candidate);
      if (statusNow(candidate, access.contacts()) !== "verified")
        throw new SyncError("unverified");
      if (!keys.signingKey) throw new SyncError("unverifiable");
      target = { publicKey: keys.publicKey, signingKey: keys.signingKey };
    }
    await this.#roles.changeRole(
      vaultId,
      userId,
      role,
      (roles) => setRole(access, vaultId, userId, role, roles),
      target,
    );
    await this.refresh();
  }

  /**
   * Leaves the vault; an owner of a vault with roles chain steps down first,
   * signed. Owners are asked to renew its key.
   */
  async leaveVault(vaultId: string): Promise<void> {
    const state = this.#state(vaultId);
    const self = this.#access.userId;
    const head = state.roles?.status === "ok" ? state.roles.head : undefined;
    if (
      state.summary.role === "owner" &&
      head?.statement.owners.some((o) => o.userId === self)
    )
      await this.#roles.changeRole(vaultId, self, "member", (roles) =>
        setRole(this.#access, vaultId, self, "member", roles),
      );
    await leave(this.#access, vaultId);
    await this.refresh();
  }

  /**
   * Accepts an invitation from a verified contact. With a roles chain the
   * box must name a statement of it and the chain must commit to the boxed
   * key; the chain's head then becomes the account's anchor.
   */
  async acceptInvitation(vaultId: string): Promise<void> {
    const invitation = this.#invitations.find(
      (i) => i.summary.vault_id === vaultId,
    );
    if (!invitation) throw new SyncError("not_found");
    if (!invitation.sender) throw new SyncError("unverified");
    const grant = invitation.summary.invitation;
    const chain = (await this.#rolesSupported())
      ? await this.#roles.invitationChain(vaultId)
      : undefined;
    const access = this.#access;
    const known =
      access.roleAnchor(vaultId) !== undefined ||
      (await access.marks.read(access.userId)).vaults[vaultId] !== undefined;
    let box: { created: string; manifest: number | undefined } | undefined;
    let named: RolePoint | undefined;
    const roles: RolesCheck = (opened) => {
      box = { created: opened.created, manifest: opened.manifest };
      named = opened.roles;
      if (!chain) return opened.roles ? "roles_invalid" : undefined;
      return checkGrantRoles({
        statements: chain,
        roles: opened.roles,
        vaultId,
        keyVersion: grant?.key_version ?? 0,
        vaultKey: opened.vaultKey,
      })
        ? "roles_rejected"
        : undefined;
    };
    await acceptGrant(
      this.#access,
      "invitation",
      invitation.summary,
      this.#candidate(invitation.sender),
      { roles },
    );
    await this.#invitationReference(vaultId, box, {
      known,
      sender: invitation.summary.invitation?.sender_id,
      statement: chain?.find(
        (s) =>
          named !== undefined &&
          s.statement.version === named.version &&
          s.hash === named.hash,
      )?.statement,
    });
    if (chain) await this.#roles.anchorInvitation(vaultId, chain);
    await this.refresh();
  }

  /**
   * The box of an accepted invitation: its manifest `seq` is a floor, and
   * its time confirms the vault if the account never had it and the sender
   * owns the statement the box names (only owners invite, naming the head
   * they checked).
   */
  async #invitationReference(
    vaultId: string,
    box: { created: string; manifest: number | undefined } | undefined,
    input: {
      known: boolean;
      sender: string | undefined;
      statement: { owners: readonly { userId: string }[] } | undefined;
    },
  ): Promise<void> {
    if (!box) return;
    const now = this.#access.now();
    const at = attestedAt(box.created, now);
    const owner =
      input.sender !== undefined &&
      input.statement?.owners.some((o) => o.userId === input.sender) === true;
    const confirms =
      !input.known && owner && at !== undefined && at >= now - this.#periodMs();
    await this.#context.marks.raise(this.#access.userId, {
      vaults: {
        [vaultId]: {
          rev: 0,
          obj: {},
          ...(box.manifest !== undefined ? { mf: box.manifest } : {}),
          ft: confirms ? at : 0,
        },
      },
    });
  }

  async declineInvitation(vaultId: string): Promise<void> {
    await decline(this.#access, vaultId);
    await this.refresh();
  }

  /**
   * Accepts a pending key after the sender was verified. With a roles chain
   * the chain decides; without one a sender who is not a known owner needs
   * `confirmOwner` (the user's confirmation).
   */
  async acceptPendingKey(
    vaultId: string,
    options: { confirmOwner?: boolean } = {},
  ): Promise<void> {
    const state = this.#state(vaultId);
    const pending = state.summary.pending_key;
    if (!pending) throw new SyncError("not_found");
    const user = await this.#publicUser(pending.sender_id);
    if (!user) throw new SyncError("unverified");
    const marks = await this.#access.marks.read(this.#access.userId);
    await acceptGrant(
      this.#access,
      "key",
      state.summary,
      this.#candidate(user),
      this.#keyChecks(state, pending.key_version, {
        owners: marks.vaults[vaultId]?.ow ?? [],
        confirmed: options.confirmOwner === true,
      }),
    );
    await this.refresh();
  }

  /** The roles check where the vault has a chain, else the known owners. */
  #keyChecks(
    state: VaultState,
    keyVersion: number,
    senders: { owners: readonly string[]; confirmed: boolean },
  ): { senders?: typeof senders; roles?: RolesCheck } {
    const roles = state.roles;
    if (!roles || roles.status === "none") return { senders };
    return {
      roles: (opened) => {
        const result = this.#roles.check(state.id, keyVersion, opened);
        if (result === undefined) return undefined;
        return result === "unchecked" ? "roles_invalid" : "roles_rejected";
      },
    };
  }

  /**
   * Loads the vault afresh for a rotation and lists what the owner must
   * decide; refused while a rollback warning is open.
   */
  async prepareRotation(vaultId: string): Promise<RotationReview> {
    const state = this.#owned(vaultId);
    if (this.#rollbackOpen(state)) throw new SyncError("rollback_open");
    // The member list is not authenticated: with an unconfirmed state the
    // new key might be boxed for a removed member.
    this.#requireConfirmed(state);
    if (state.manifest.status === "mismatch")
      throw new SyncError("manifest_mismatch");
    // The rotation renews the manifest; one that is missing comes first,
    // and so does a roles chain.
    await this.#ensureManifest(state);
    await this.#ensureRoles(state);
    // Only an owner of the signed list can sign the rotation's statement.
    const head = state.roles?.status === "ok" ? state.roles.head : undefined;
    if (
      head &&
      !head.statement.owners.some((o) => o.userId === this.#access.userId)
    )
      throw new SyncError("read_only");
    return prepareRotation(
      this.#access,
      vaultId,
      this.#vaultName(state),
      state.manifestFloor,
    );
  }

  /** Runs a reviewed rotation. */
  async runRotation(
    review: RotationReview,
    decisions: RotationDecisions,
    onProgress?: (progress: { done: number; total: number }) => void,
  ): Promise<void> {
    const state = this.#owned(review.vaultId);
    const roles = await this.#rolesSupported();
    await runRotation(this.#access, review, decisions, {
      onProgress,
      stale: (base) => state.since > base,
      ...(roles
        ? {
            roles: (members, removed, reload) =>
              this.#roles.rotationRoles(
                review.vaultId,
                members,
                removed,
                reload,
              ),
          }
        : {}),
    });
    await this.refresh();
  }

  async deleteVault(vaultId: string, password: string): Promise<void> {
    const state = this.#states.get(vaultId);
    if (!state) throw new SyncError("not_found");
    if (state.summary.role !== "owner") throw new SyncError("read_only");
    const token = await this.#access.reauth(password);
    try {
      await this.#access.api.deleteVault(vaultId, token);
    } catch (error) {
      // A repetition after a lost answer: already deleted.
      if (!(error instanceof ApiError && error.code === "not_found"))
        throw error;
    }
    this.#states.delete(vaultId);
    this.#projections.delete(vaultId);
    this.#access.keys.forgetVault(vaultId);
    await this.#access.marks.forgetVault(this.#access.userId, vaultId);
    this.#emit();
  }

  async updateVault(
    vaultId: string,
    change: VaultChange,
  ): Promise<WriteResult> {
    const state = this.#state(vaultId);
    const meta = state.meta;
    const value = metaOf(state);
    if (!meta) throw new SyncError("read_only");
    const fields: Record<string, unknown> = {};
    if (change.name !== undefined) {
      const name = normalizeName(change.name);
      if (!name) throw new SyncError("invalid_name");
      if (name !== value.name) fields.name = name;
    }
    if (
      change.description !== undefined &&
      change.description !== value.description
    )
      fields.description = change.description;
    if (change.color !== undefined && change.color !== value.color)
      fields.color = change.color;
    if (change.icon !== undefined && !same(change.icon, value.icon))
      fields.icon = change.icon;
    if (
      change.recycleBinEnabled !== undefined &&
      change.recycleBinEnabled !== value.recycleBinEnabled
    )
      fields.recycleBinEnabled = change.recycleBinEnabled;
    if (change.historyMaxItems !== undefined) {
      const max = change.historyMaxItems;
      if (!Number.isInteger(max) || max < 0 || max > 100)
        throw new SyncError("invalid_name");
      if (max !== value.historyMaxItems) fields.historyMaxItems = max;
    }
    if (Object.keys(fields).length === 0) return noChange();
    return this.#update(state, meta.id, fields);
  }

  /** Moves a vault one place up (`-1`) or down (`1`) in `vaultOrder`. */
  async moveVault(vaultId: string, direction: -1 | 1): Promise<void> {
    const order = this.snapshot.vaults.map((v) => v.id);
    const index = order.indexOf(vaultId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    const other = order[target] ?? vaultId;
    order[target] = vaultId;
    order[index] = other;
    await this.#access.setVaultOrder(order);
    this.#emit();
  }

  async acknowledgeRollback(vaultId: string): Promise<void> {
    const state = this.#state(vaultId);
    await state.lock.run(async () => {
      await acknowledgeRollback(this.#context, state);
      this.#evaluate(state);
    });
    this.#emit();
    await this.#attest(state);
  }

  /**
   * "Understood" at "The server is withholding data": a full sync, the
   * rollback warnings of the vault acknowledged with it, and if the state
   * still does not match, the manifest rebuilt from what was delivered.
   */
  async acknowledgeManifest(vaultId: string): Promise<void> {
    const state = this.#state(vaultId);
    try {
      await state.lock.run(async () => {
        state.synced = false;
        await pullVault(this.#context, state);
        await acknowledgeRollback(this.#context, state);
        this.#evaluate(state);
        if (state.manifest.status === "mismatch")
          await this.#operation(state, () => [], "rebuild").run();
      });
    } finally {
      this.#emit();
    }
    await this.#attest(state);
  }

  // ------------------------------------------------------------ groups

  async createGroup(
    vaultId: string,
    parentId: string,
    props: GroupProps,
  ): Promise<WriteResult & { id: string }> {
    const state = this.#state(vaultId);
    const name = normalizeName(props.name);
    if (!name) throw new SyncError("invalid_name");
    const id = systemRandomness.id("group_id");
    const ops = this.#ops(state);
    const result = await this.#write(state, () =>
      planNewGroup(ops, id, parentId, { ...props, name }),
    );
    return { ...result, id };
  }

  /** Many groups at once (below the root unless given), in limited batches. */
  async createGroups(
    vaultId: string,
    specs: readonly { name: string; parentId?: string }[],
  ): Promise<string[]> {
    const state = this.#state(vaultId);
    const ops = this.#ops(state);
    const layout = layoutOf(ops);
    const now = stamp(this.#access.userId);
    const ids = specs.map(() => systemRandomness.id("group_id"));
    const created = new Set(ids);
    const byParent = new Map<string, number[]>();
    specs.forEach((spec, i) => {
      const parent = spec.parentId ?? layout.rootId;
      if (!created.has(parent) && !isGroupNode(ops, layout, parent))
        throw new SyncError("invalid_target");
      byParent.set(parent, [...(byParent.get(parent) ?? []), i]);
    });
    const keys = new Map<number, string>();
    for (const [parent, indexes] of byParent) {
      const existing = (layout.children.get(parent) ?? []).map(
        (id) => ops.projection.group(id)?.sortKey ?? "",
      );
      keysAtEnd(existing, indexes.length).forEach((key, j) =>
        keys.set(indexes[j] ?? 0, key),
      );
    }
    const intents: Intent[] = specs.map((spec, i) => {
      const name = normalizeName(spec.name);
      if (!name) throw new SyncError("invalid_name");
      return {
        kind: "create",
        id: ids[i] ?? "",
        type: "group",
        content: newGroup(
          {
            name,
            parentId: spec.parentId ?? layout.rootId,
            sortKey: keys.get(i) ?? "",
          },
          now,
        ),
      };
    });
    await this.#writeAll(state, intents);
    return ids;
  }

  /** Changes name, icons or notes; only what differs is written. */
  async updateGroup(
    vaultId: string,
    groupId: string,
    change: Partial<GroupProps>,
  ): Promise<WriteResult> {
    const state = this.#state(vaultId);
    const group = this.#projection(state).group(groupId);
    const object = state.objects.get(groupId);
    if (!group || !object) throw new SyncError("not_found");
    const fields: Record<string, unknown> = {};
    if (change.name !== undefined) {
      const name = normalizeName(change.name);
      if (!name) throw new SyncError("invalid_name");
      if (name !== group.name) fields.name = name;
    }
    if (change.icon !== undefined && !same(change.icon, group.icon))
      fields.icon = change.icon;
    if (
      change.defaultEntryIcon !== undefined &&
      !same(change.defaultEntryIcon, group.defaultEntryIcon)
    )
      fields.defaultEntryIcon = change.defaultEntryIcon;
    if (change.notes !== undefined && change.notes !== group.notes)
      fields.notes = change.notes;
    if (Object.keys(fields).length === 0) return noChange();
    return this.#update(state, groupId, fields);
  }

  renameGroup(
    vaultId: string,
    groupId: string,
    name: string,
  ): Promise<WriteResult> {
    return this.updateGroup(vaultId, groupId, { name });
  }

  /** One place up (`-1`) or down (`1`) among its siblings. */
  async reorderGroup(
    vaultId: string,
    groupId: string,
    direction: -1 | 1,
  ): Promise<WriteResult> {
    const state = this.#state(vaultId);
    const layout = layoutOf(this.#ops(state));
    const parent = layout.parent.get(groupId);
    if (parent === undefined) throw new SyncError("invalid_target");
    const others = (layout.children.get(parent) ?? []).filter(
      (id) => id !== groupId,
    );
    const index =
      (layout.children.get(parent) ?? []).indexOf(groupId) + direction;
    if (index < 0 || index > others.length) return noChange();
    return this.move(vaultId, [{ kind: "group", id: groupId }], {
      vaultId,
      groupId: parent,
      before: others[index],
    });
  }

  // ------------------------------------------------------------ items

  /** Whether a move is allowed, for drag and drop. */
  canMove(
    vaultId: string,
    items: readonly ItemRef[],
    target: MoveTarget,
  ): MoveCheck {
    const source = this.#states.get(vaultId);
    const destination = this.#states.get(target.vaultId);
    if (!source || !destination || items.length === 0)
      return { ok: false, reason: "target" };
    const ops = this.#ops(source);
    return checkMove(
      ops,
      target.vaultId === vaultId ? ops : this.#ops(destination),
      items,
      target,
    );
  }

  /** Moves groups and entries; to another vault in two phases. */
  async move(
    vaultId: string,
    items: readonly ItemRef[],
    target: MoveTarget,
  ): Promise<WriteResult> {
    const check = this.canMove(vaultId, items, target);
    if (!check.ok)
      throw new SyncError(
        check.reason === "read_only" ? "read_only" : "invalid_target",
      );
    if (target.vaultId !== vaultId)
      return this.#moveAcross(vaultId, items, target);
    const state = this.#state(vaultId);
    const ops = this.#ops(state);
    const bases = basesOf(state, items);
    return this.#write(state, () => planMove(ops, items, target, bases));
  }

  /** Entries whose references break if `items` move to another vault. */
  brokenReferences(vaultId: string, items: readonly ItemRef[]): number {
    return brokenReferences(this.#ops(this.#state(vaultId)), items);
  }

  deletePlan(vaultId: string, items: readonly ItemRef[]): DeletePlan {
    return deletePlan(this.#ops(this.#state(vaultId)), items);
  }

  /** Into the recycle bin, creating it when missing. */
  async trash(
    vaultId: string,
    items: readonly ItemRef[],
    recycleBinName: string,
  ): Promise<WriteResult> {
    const state = this.#state(vaultId);
    const ops = this.#ops(state);
    if (deletePlan(ops, items).mode !== "trash")
      throw new SyncError("invalid_target");
    const name = normalizeName(recycleBinName);
    if (!name) throw new SyncError("invalid_name");
    const bases = basesOf(state, items);
    const bin = { id: systemRandomness.id("group_id"), name };
    return this.#write(state, () => planTrash(ops, items, bases, bin));
  }

  async restore(
    vaultId: string,
    items: readonly ItemRef[],
  ): Promise<WriteResult> {
    const state = this.#state(vaultId);
    const ops = this.#ops(state);
    const bases = basesOf(state, items);
    return this.#write(state, () => planRestore(ops, items, bases));
  }

  /** Deletes for good, bottom-up in limited batches. */
  async destroy(
    vaultId: string,
    items: readonly ItemRef[],
  ): Promise<WriteResult> {
    const state = this.#state(vaultId);
    return this.#writeAll(state, destroyIntents(this.#ops(state), items));
  }

  async emptyRecycleBin(vaultId: string): Promise<WriteResult> {
    const state = this.#state(vaultId);
    const layout = layoutOf(this.#ops(state));
    if (layout.binId === undefined) return noChange();
    const items: ItemRef[] = [
      ...(layout.children.get(layout.binId) ?? []).map((id) => ({
        kind: "group" as const,
        id,
      })),
      ...(layout.entries.get(layout.binId) ?? []).map((id) => ({
        kind: "entry" as const,
        id,
      })),
    ];
    return this.destroy(vaultId, items);
  }

  /** A missing root first, then orphans and cycles below the root. */
  async repair(vaultId: string, rootName: string): Promise<WriteResult> {
    const state = this.#state(vaultId);
    const ops = this.#ops(state);
    const notices: Notice[] = [];
    if (layoutOf(ops).missingRoot) {
      const name = normalizeName(rootName);
      if (!name) throw new SyncError("invalid_name");
      const id = systemRandomness.id("group_id");
      const result = await this.#write(state, () =>
        newRootIntents(ops, id, name),
      );
      notices.push(...result.notices);
    }
    const result = await this.#writeAll(state, repairIntents(ops));
    return { notices: [...notices, ...result.notices] };
  }

  // ------------------------------------------------------------ entries

  /**
   * `id` from [`newEntryId`] lets the editor upload attachments before the
   * entry exists.
   */
  async createEntry(
    vaultId: string,
    groupId: string,
    draft: EntryDraft,
    id?: string,
  ): Promise<WriteResult & { id: string }> {
    const [created = ""] = await this.createEntries(
      vaultId,
      groupId,
      [draft],
      id === undefined ? undefined : [id],
    );
    return { notices: [], id: created };
  }

  /** An ID for an entry the editor is about to create. */
  newEntryId(): string {
    return systemRandomness.id("entry_id");
  }

  /** New entries at the end of a group, in limited batches. */
  async createEntries(
    vaultId: string,
    groupId: string,
    drafts: readonly EntryDraft[],
    entryIds?: readonly string[],
  ): Promise<string[]> {
    const state = this.#state(vaultId);
    const ops = this.#ops(state);
    const layout = layoutOf(ops);
    if (
      !isGroupNode(ops, layout, groupId) ||
      layout.inTrash.has(groupId) ||
      groupId === layout.binId
    )
      throw new SyncError("invalid_target");
    // The group chain's default icon is copied into new entries.
    let inherited = null;
    for (const id of [groupId, ...ancestors(layout, groupId).reverse()]) {
      inherited = ops.projection.group(id)?.defaultEntryIcon ?? null;
      if (inherited) break;
    }
    const keys = keysAtEnd(
      (layout.entries.get(groupId) ?? []).map(
        (id) => ops.projection.entry(id)?.sortKey ?? "",
      ),
      drafts.length,
    );
    const context = this.#saveContext(state);
    const ids = drafts.map((_, i) => entryIds?.[i] ?? this.newEntryId());
    drafts.forEach((draft, i) => {
      const id = ids[i] ?? "";
      if (
        validateEntryDraft(draft, undefined).length > 0 ||
        draft.attachments.some(
          (a) => !this.#attachments.isStaged(a, vaultId, id),
        )
      )
        throw new SyncError("invalid_entry");
    });
    const intents: Intent[] = [];
    for (const [i, draft] of drafts.entries()) {
      // Uploads complete right before the entry is written.
      const added = await this.#attachments.complete(
        vaultId,
        draft.attachments,
      );
      intents.push({
        kind: "create",
        id: ids[i] ?? "",
        type: "entry",
        content: this.#sized(() =>
          newEntry(
            {
              parentId: groupId,
              sortKey: keys[i] ?? "",
              draft: { ...draft, icon: draft.icon ?? inherited },
            },
            context,
            added,
          ),
        ),
      });
    }
    await this.#writeAll(state, intents);
    this.#attachments.forget(drafts.flatMap((d) => d.attachments));
    return ids;
  }

  /** The draft of an entry and the base its save refers to. */
  editEntry(
    vaultId: string,
    entryId: string,
  ): { draft: EntryDraft; base: EntryBase } | undefined {
    const state = this.#states.get(vaultId);
    const object = state?.objects.get(entryId);
    const entry = state && this.#projection(state).entry(entryId);
    if (!state || !object || !entry) return undefined;
    const base = new EntryBase(vaultId, entryId, object.revision);
    baseRaws.set(base, object.raw);
    return { draft: draftOf(entry), base };
  }

  async saveEntry(base: EntryBase, draft: EntryDraft): Promise<WriteResult> {
    const raw = baseRaws.get(base);
    const state = this.#state(base.vaultId);
    if (!raw) throw new SyncError("not_found");
    const current = this.#projection(state).entry(base.entryId);
    const stored = new Set(current?.attachments.map((a) => a.id));
    if (
      validateEntryDraft(draft, current ?? undefined).length > 0 ||
      draft.attachments.some(
        (a) =>
          !stored.has(a) &&
          !this.#attachments.isStaged(a, base.vaultId, base.entryId),
      )
    )
      throw new SyncError("invalid_entry");
    // Uploads complete right before the entry is written.
    const added = await this.#attachments.complete(
      base.vaultId,
      draft.attachments.filter((a) => !stored.has(a)),
    );
    const local = this.#sized(() =>
      applyEntryEdit(raw, draft, this.#saveContext(state), added),
    );
    if (!local) return noChange();
    const result = await this.#write(state, () => [
      {
        kind: "update",
        id: base.entryId,
        baseRaw: raw,
        baseRevision: base.revision,
        local,
      },
    ]);
    this.#attachments.forget(added.keys());
    await this.#dropUnreferenced(state, base.entryId, raw, local);
    return result;
  }

  /**
   * After a write without conflict, deletes the blobs the old version
   * referenced and the new one does not; after a merge nothing.
   */
  async #dropUnreferenced(
    state: VaultState,
    entryId: string,
    before: JsonObject,
    local: JsonObject,
  ): Promise<void> {
    if (state.objects.get(entryId)?.raw !== local) return;
    await this.#attachments.remove(state.id, unreferenced(before, local));
  }

  // ------------------------------------------------------------ icons

  /**
   * Adds finished PNG bytes of the app to the vault's icon library
   * in an own batch and returns the icon's ID; a valid live icon with the
   * same hash is chosen instead.
   */
  async addIcon(
    vaultId: string,
    png: Uint8Array,
    name: string,
    source: IconSource,
  ): Promise<string> {
    const state = this.#state(vaultId);
    if (!isIconPng(png)) throw new SyncError("invalid_icon");
    const hash = iconHash(png);
    const id = systemRandomness.id("icon_id");
    const content = newIcon({ png, name, source }, stamp(this.#access.userId));
    let chosen = id;
    await this.#write(state, (current) => {
      const known = this.#iconWithHash(current, hash);
      chosen = known ?? id;
      return known === undefined
        ? [{ kind: "create", id, type: "icon", content }]
        : [];
    });
    return chosen;
  }

  #iconWithHash(state: VaultState, hash: string): string | undefined {
    for (const [id, icon] of this.#projection(state).library(state))
      if (icon.hash === hash) return id;
    return undefined;
  }

  /**
   * A website's favicon as checked PNG bytes; only the origin of
   * `url` goes to the server. The app re-encodes it for `addIcon`.
   */
  async favicon(url: string): Promise<{ png: Uint8Array; origin: string }> {
    const target = faviconTarget(url);
    if (target === undefined) throw new SyncError("invalid_url");
    const answer = await this.#access.api.favicon(target);
    let png: Uint8Array;
    try {
      png = fromBase64Url(answer.data);
    } catch {
      throw new SyncError("invalid_icon");
    }
    if (!isIconPng(png)) throw new SyncError("invalid_icon");
    return { png, origin: answer.origin };
  }

  /**
   * "Remove unused icons": tombstones for every writable icon no
   * live object refers to; returns how many were removed.
   */
  async removeUnusedIcons(vaultId: string): Promise<number> {
    const state = this.#state(vaultId);
    if (!vaultWritable(state)) throw new SyncError("read_only");
    if (
      [...state.corrupt.values()].some(
        (c) => c.type !== "icon" && c.type !== "manifest",
      )
    )
      throw new SyncError("corrupt_objects");
    const used = usedIcons(state);
    const intents: Intent[] = [];
    for (const id of this.#projection(state).library(state).keys()) {
      const object = state.objects.get(id);
      if (!used.has(id) && object && objectWritable(object))
        intents.push({ kind: "delete", id, baseRevision: object.revision });
    }
    if (intents.length > 0) await this.#writeAll(state, byBucket(intents));
    return intents.length;
  }

  // ------------------------------------------------------------ attachments

  /** `attachment_max_bytes` of the server. */
  attachmentLimit(): Promise<number> {
    return this.#attachments.limit();
  }

  /**
   * Uploads a file for an entry being edited; the returned ID goes
   * into the draft, and saving completes it. `entryId` of a new entry
   * comes from [`newEntryId`].
   */
  stageAttachment(
    vaultId: string,
    entryId: string,
    file: AttachmentFile,
    run?: AttachmentRun,
  ): Promise<AttachmentInfo> {
    this.#state(vaultId);
    return this.#attachments.stage(vaultId, entryId, file, run);
  }

  /** Uploads the editor gave up on: deleted unless an entry stored them. */
  discardAttachments(vaultId: string, entryId: string, ids: string[]): void {
    const raw = this.#states.get(vaultId)?.objects.get(entryId)?.raw;
    const stored = raw ? referencedAttachments(raw) : new Set<string>();
    this.#attachments.discard(ids, (id) => stored.has(id));
  }

  /**
   * The file of an attachment of the entry or one of its snapshots,
   * decrypted in the core.
   */
  readAttachment(
    vaultId: string,
    entryId: string,
    attachmentId: string,
    run?: AttachmentRun,
  ): Promise<Uint8Array> {
    const object = this.#states.get(vaultId)?.objects.get(entryId);
    if (object?.type !== "entry")
      return Promise.reject(new SyncError("attachment_missing"));
    return this.#attachments.read(vaultId, object.raw, attachmentId, run);
  }

  /** Makes snapshot `index` the current content. */
  async restoreHistory(
    vaultId: string,
    entryId: string,
    index: number,
  ): Promise<WriteResult> {
    const state = this.#state(vaultId);
    const object = state.objects.get(entryId);
    if (object?.type !== "entry") throw new SyncError("not_found");
    let local;
    try {
      local = this.#sized(() =>
        restoreEntrySnapshot(object.raw, index, this.#saveContext(state)),
      );
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError("invalid_target");
    }
    if (!local) return noChange();
    const update: Intent = {
      kind: "update",
      id: entryId,
      baseRaw: object.raw,
      baseRevision: object.revision,
      local,
    };
    const result = await this.#write(state, () => [update]);
    await this.#dropUnreferenced(state, entryId, object.raw, local);
    return result;
  }

  /** Removes invalid list elements after confirmation. */
  async repairEntry(vaultId: string, entryId: string): Promise<WriteResult> {
    const state = this.#state(vaultId);
    const object = state.objects.get(entryId);
    if (object?.type !== "entry") throw new SyncError("not_found");
    const local = withoutInvalidElements(
      object.raw,
      stamp(this.#access.userId),
    );
    const update: Intent = {
      kind: "update",
      id: entryId,
      baseRaw: object.raw,
      baseRevision: object.revision,
      local,
      allowInvalid: true,
    };
    return this.#write(state, () => [update]);
  }

  /** Values, history and path of one entry; the app drops it when done. */
  entry(vaultId: string, entryId: string): EntryDetail | undefined {
    const state = this.#states.get(vaultId);
    return (
      state && this.#projection(state).detail(state, entryId, this.#collator)
    );
  }

  /**
   * The URL of a draft resolved against the vault, for the
   * editor's preview; `undefined` for an empty URL or unknown vault.
   */
  previewUrl(
    vaultId: string,
    entryId: string | undefined,
    draft: EntryDraft,
  ): ResolvedUrl | undefined {
    const state = this.#states.get(vaultId);
    if (!state || draft.url.trim() === "") return undefined;
    const projection = this.#projection(state);
    projection.layoutOf(state, this.#collator);
    // A new entry has no ID yet, so no reference can reach it.
    const id = entryId ?? "";
    return resolveUrl(id, {
      entry: (target) =>
        target === id ? draft : projection.lookup.entry(target),
    });
  }

  /** Entries matching a query, from the current projection. */
  search(query: SearchQuery): EntrySummary[] {
    const terms = searchTerms(query.text);
    if (terms.length === 0) return [];
    const scope = query.scope;
    const results: EntrySummary[] = [];
    for (const view of this.snapshot.vaults) {
      if (scope.kind !== "all" && scope.vaultId !== view.id) continue;
      const state = this.#states.get(view.id);
      if (!state) continue;
      const projection = this.#projection(state);
      const layout = projection.layoutOf(state, this.#collator);
      const inGroup =
        scope.kind === "group"
          ? new Set(subtree(layout, scope.groupId).entries)
          : undefined;
      const trashScope =
        scope.kind === "group" &&
        (scope.groupId === layout.binId || layout.inTrash.has(scope.groupId));
      for (const summary of view.entries.values()) {
        if (inGroup && !inGroup.has(summary.id)) continue;
        if (summary.inTrash && !query.includeTrash && !trashScope) continue;
        const entry = projection.entry(summary.id);
        if (entry && this.#search.matches(entry, terms, query.searchProtected))
          results.push(summary);
      }
    }
    return results;
  }

  // ------------------------------------------------------------ TOTP

  /** The current server time in ms, for TOTP countdowns. */
  serverNow(): number {
    return this.#clock.now();
  }

  /**
   * The current and next TOTP code of an entry, computed here so the secret
   * stays out of the list views; `undefined` without `otp`.
   */
  async totp(
    vaultId: string,
    entryId: string,
  ): Promise<TotpResult | undefined> {
    const state = this.#states.get(vaultId);
    if (!state) return undefined;
    const projection = this.#projection(state);
    projection.layoutOf(state, this.#collator);
    const otp = projection.entry(entryId)?.otp ?? null;
    return otp === null ? undefined : totpFromUri(otp, this.#clock.now());
  }

  // ------------------------------------------------------------ KDBX

  /**
   * Plans a KDBX import into a new vault or below a group; the
   * returned job writes it. `emptyFieldName` names fields without a name.
   * `icons`: the file's custom icons by UUID, re-encoded by the app as
   * 64 × 64 PNG; missing ones count as unreadable.
   */
  async prepareKdbxImport(
    file: KdbxFile,
    target: KdbxImportTarget,
    texts: {
      emptyFieldName: string;
      icons?: ReadonlyMap<string, Uint8Array>;
    },
  ): Promise<KdbxImportJob> {
    const userId = this.#access.userId;
    const attachmentMaxBytes = await this.#attachments.limit();
    // Prepared uploads stay until they went up, so repeats send the same bytes.
    const prepared = new Map<string, PreparedUpload>();
    const port: KdbxImportPort = {
      createVault: (meta, root) =>
        this.#createVault([
          { label: "meta", type: "vault_meta", content: meta },
          { label: "root", type: "group", id: root.id, content: root.raw },
        ]),
      state: (vaultId) => this.#state(vaultId),
      knownTombstones: async (vaultId) => {
        const marks = (await this.#context.marks.read(userId)).vaults[vaultId];
        return new Set(
          Object.entries(marks?.obj ?? {})
            .filter(([, seq]) => seq < 0)
            .map(([id]) => id),
        );
      },
      write: (state, plan) => this.#write(state, plan),
      newId: () => systemRandomness.id("object_id"),
      stamp: () => stamp(userId),
      uploadAttachment: async (vaultId, entryId, attachmentId, upload) => {
        let item = prepared.get(attachmentId);
        if (!item) {
          item = await this.#attachments.prepare(attachmentId, upload);
          prepared.set(attachmentId, item);
        }
        await this.#attachments.send(vaultId, entryId, item);
        prepared.delete(attachmentId);
        return { key: item.key, compression: item.compression };
      },
      transferAttachment: (vaultId, attachmentId, entryId) =>
        this.#access.api.transferAttachment(
          vaultId,
          attachmentId,
          vaultId,
          entryId,
        ),
    };
    const base = {
      emptyFieldName: texts.emptyFieldName,
      icons: texts.icons,
      stamp: stamp(userId),
      newId: (label: string) => systemRandomness.id(label),
      attachmentMaxBytes,
    };
    if (target.kind === "vault") {
      const name = normalizeName(target.name);
      if (!name) throw new SyncError("invalid_name");
      const plan = planKdbxImport(file, {
        ...base,
        mode: "vault",
        name,
        historyMaxItems: 10,
      });
      return new KdbxImportJob(plan, port);
    }
    const state = this.#state(target.vaultId);
    if (!vaultWritable(state)) throw new SyncError("read_only");
    const ops = this.#ops(state);
    const layout = layoutOf(ops);
    if (
      !isGroupNode(ops, layout, target.groupId) ||
      layout.inTrash.has(target.groupId) ||
      target.groupId === layout.binId
    )
      throw new SyncError("invalid_target");
    const existingIcons = new Map<string, string>();
    for (const [id, icon] of this.#projection(state).library(state))
      if (!existingIcons.has(icon.hash)) existingIcons.set(icon.hash, id);
    const plan = planKdbxImport(file, {
      ...base,
      mode: "group",
      name: "",
      historyMaxItems: metaOf(state).historyMaxItems,
      existingIcons,
    });
    return new KdbxImportJob(plan, port, {
      vaultId: target.vaultId,
      groupId: target.groupId,
      sortKey: keyAtEnd(
        (layout.children.get(target.groupId) ?? []).map(
          (id) => ops.projection.group(id)?.sortKey ?? "",
        ),
      ),
    });
  }

  /**
   * The KDBX export model of a vault with its attachments, downloaded and
   * decrypted here, and its report; unreadable ones are reported. The worker
   * writes the file. Contains secrets: never into reactive state.
   */
  async exportKdbx(
    vaultId: string,
    run: AttachmentRun = {},
  ): Promise<{ model: KdbxExportModel; report: KdbxExportReport }> {
    const built = this.#exportModel(vaultId);
    const { attachments } = built;
    const files: (Uint8Array | KdbxSkipped)[] = [];
    // All files stay in memory until the file is written: a total bound,
    // so small attachments that unpack big cannot exhaust it. What is left
    // of it bounds each read like the server's limit (checked with the
    // size the read uses, before downloading), and the actual length is
    // checked again.
    let total = 0;
    for (const [index, attachment] of attachments.entries()) {
      if (run.signal?.aborted) throw new SyncError("cancelled");
      try {
        const left = KDBX_EXPORT_ATTACHMENT_BYTES - total;
        const file = await this.readAttachment(
          vaultId,
          attachment.entryId,
          attachment.attachmentId,
          { signal: run.signal, maxSize: left },
        );
        if (file.length > left) {
          file.fill(0);
          files.push("too_large");
        } else {
          total += file.length;
          files.push(file);
        }
      } catch (error) {
        if (error instanceof SyncError && error.code === "cancelled")
          throw error;
        if (error instanceof SyncError && error.code === "attachment_too_large")
          files.push("too_large");
        else if (
          error instanceof SyncError &&
          ["attachment_missing", "attachment_corrupt"].includes(error.code)
        )
          files.push("unreadable");
        else throw error;
      }
      run.onProgress?.({ done: index + 1, total: attachments.length });
    }
    attachKdbxBinaries(built.model, built.report, attachments, files);
    return { model: built.model, report: built.report };
  }

  #exportModel(vaultId: string): ReturnType<typeof buildKdbxExport> {
    const state = this.#state(vaultId);
    const meta = metaOf(state);
    const projection = this.#projection(state);
    const library = projection.library(state);
    const times = (id: string): KdbxTimes => {
      const raw = state.objects.get(id)?.raw ?? {};
      return {
        created: timestampOf(raw, "created") ?? null,
        modified: timestampOf(raw, "modified") ?? null,
        expires: null,
      };
    };
    return buildKdbxExport({
      meta,
      layout: projection.layoutOf(state, this.#collator),
      group: (id) => {
        const value = projection.group(id);
        return value && { value, times: times(id) };
      },
      entry: (id) => {
        const value = projection.entry(id);
        return value && { value, times: times(id) };
      },
      icon: (id) => {
        const icon = library.get(id);
        return icon && fromBase64Url(icon.data);
      },
      corrupt: state.corrupt.size,
      newId: () => systemRandomness.id("object_id"),
    });
  }

  // ------------------------------------------------------------ internals

  /** Two phases: create in the target, then delete in the source. */
  async #moveAcross(
    vaultId: string,
    items: readonly ItemRef[],
    target: MoveTarget,
  ): Promise<WriteResult> {
    const source = this.#state(vaultId);
    const destination = this.#state(target.vaultId);
    const sourceOps = this.#ops(source);
    const destOps = this.#ops(destination);
    const layout = layoutOf(sourceOps);
    const destLayout = layoutOf(destOps);
    // Top-down order: every parent comes before its children.
    const order: ItemRef[] = [];
    const top = new Set(items.map((i) => i.id));
    for (const item of items) {
      if (item.kind === "entry") {
        order.push(item);
        continue;
      }
      const tree = subtree(layout, item.id);
      order.push(...tree.groups.map((id) => ({ kind: "group" as const, id })));
      order.push(...tree.entries.map((id) => ({ kind: "entry" as const, id })));
    }
    const raws = new Map(
      order.map((item) => [
        item.id,
        clone(source.objects.get(item.id)?.raw ?? {}),
      ]),
    );
    const marks = (await this.#context.marks.read(this.#access.userId)).vaults[
      destination.id
    ];
    const ids = new IdMap(
      (id, tombstones) =>
        isManifestId(destination.id, id) ||
        destination.objects.has(id) ||
        destination.corrupt.has(id) ||
        tombstones.has(id) ||
        (marks?.obj[id] ?? 0) < 0,
      () => systemRandomness.id("object_id"),
    );
    const topItems = order.filter((item) => top.has(item.id));
    const topKeys = new Map<string, string>();
    const groupKeys = keysAtEnd(
      (destLayout.children.get(target.groupId) ?? []).map(
        (id) => destOps.projection.group(id)?.sortKey ?? "",
      ),
      topItems.filter((i) => i.kind === "group").length,
    );
    const entryKeys = keysAtEnd(
      (destLayout.entries.get(target.groupId) ?? []).map(
        (id) => destOps.projection.entry(id)?.sortKey ?? "",
      ),
      topItems.filter((i) => i.kind === "entry").length,
    );
    topItems
      .filter((i) => i.kind === "group")
      .forEach((i, n) => topKeys.set(i.id, groupKeys[n] ?? ""));
    topItems
      .filter((i) => i.kind === "entry")
      .forEach((i, n) => topKeys.set(i.id, entryKeys[n] ?? ""));
    const now = stamp(this.#access.userId);
    const notices: Notice[] = [];
    // Custom icons go first; the moved objects then refer to the target's
    // copies or to icons it already has with the same hash.
    const icons = await this.#copyIcons(source, destination, raws, ids, now);
    notices.push(...icons.notices);
    const content = (item: ItemRef, tombstones: ReadonlySet<string>) => {
      const raw = renameIconRefs(raws.get(item.id) ?? {}, icons.ids);
      const parent = String(raw.parentId);
      setOwn(
        raw,
        "parentId",
        top.has(item.id) ? target.groupId : ids.map(parent, tombstones),
      );
      if (top.has(item.id)) setOwn(raw, "sortKey", topKeys.get(item.id) ?? "");
      Reflect.deleteProperty(raw, "previousParentId");
      setOwn(raw, "seq", 1);
      setOwn(raw, "modified", now.now);
      setOwn(raw, "modifiedBy", now.userId);
      return raw;
    };
    const batches = chunks(
      order.map((item) => ({
        kind: "create",
        id: item.id,
        type: item.kind,
        content: raws.get(item.id) ?? {},
      })),
      { ...manifestCost(destination), allShards: true },
    );
    let offset = 0;
    for (const batch of batches) {
      const part = order.slice(offset, offset + batch.length);
      offset += batch.length;
      const result = await this.#write(destination, (_state, info) =>
        part.map((item) => ({
          kind: "create",
          id: ids.map(item.id, info.tombstones),
          type: item.kind,
          content: content(item, info.tombstones),
        })),
      );
      for (const item of part) ids.created(item.id);
      notices.push(...result.notices);
    }
    // Attachments follow their entries before anything leaves the source.
    const transfers = order
      .filter((item) => item.kind === "entry")
      .flatMap((item) =>
        [...referencedAttachments(raws.get(item.id) ?? {})].map((id) => ({
          id,
          entry: item.id,
          target: ids.peek(item.id),
        })),
      );
    const moved: typeof transfers = [];
    try {
      for (const transfer of transfers) {
        try {
          await this.#access.api.transferAttachment(
            vaultId,
            transfer.id,
            target.vaultId,
            transfer.target,
          );
          moved.push(transfer);
        } catch (error) {
          // Unknown to the server: nothing to move.
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
      }
    } catch (error) {
      const copies = topItems.map((item) => ({
        kind: item.kind,
        id: ids.peek(item.id),
      }));
      await this.#undoMove(vaultId, destination, copies, moved, icons.created);
      throw error;
    }
    try {
      const removal = await this.#writeAll(
        source,
        destroyIntents(sourceOps, items),
      );
      notices.push(...removal.notices);
    } catch (error) {
      if (error instanceof SyncError && error.code === "network") throw error;
      throw new SyncError("move_incomplete");
    }
    return { notices };
  }

  /**
   * Copies the valid live icons the moved objects refer to. An
   * icon with the same hash in the target is used instead; a copy keeps its
   * content and its ID unless that is taken there. Returns the new IDs per
   * source icon and the copies created.
   */
  async #copyIcons(
    source: VaultState,
    destination: VaultState,
    raws: ReadonlyMap<string, JsonObject>,
    ids: IdMap,
    now: Stamp,
  ): Promise<{
    ids: Map<string, string>;
    created: string[];
    notices: Notice[];
  }> {
    const library = this.#projection(source).library(source);
    const known = new Map<string, string>();
    for (const [id, icon] of this.#projection(destination).library(destination))
      if (!known.has(icon.hash)) known.set(icon.hash, id);
    const renamed = new Map<string, string>();
    const copies: string[] = [];
    for (const raw of raws.values())
      for (const id of iconRefs(raw)) {
        const icon = library.get(id);
        if (!icon || renamed.has(id) || copies.includes(id)) continue;
        const same = known.get(icon.hash);
        if (same === undefined) copies.push(id);
        else renamed.set(id, same);
      }
    const content = (id: string) => {
      const raw = clone(source.objects.get(id)?.raw ?? {});
      setOwn(raw, "seq", 1);
      setOwn(raw, "modified", now.now);
      setOwn(raw, "modifiedBy", now.userId);
      return raw;
    };
    const notices: Notice[] = [];
    let offset = 0;
    for (const batch of chunks(
      copies.map((id): Intent => ({
        kind: "create",
        id,
        type: "icon",
        content: content(id),
      })),
      { ...manifestCost(destination), allShards: true },
    )) {
      const part = copies.slice(offset, offset + batch.length);
      offset += batch.length;
      const result = await this.#write(destination, (_state, info) =>
        part.map((id) => ({
          kind: "create",
          id: ids.map(id, info.tombstones),
          type: "icon",
          content: content(id),
        })),
      );
      for (const id of part) ids.created(id);
      notices.push(...result.notices);
    }
    for (const id of copies) renamed.set(id, ids.peek(id));
    return { ids: renamed, created: copies.map((id) => ids.peek(id)), notices };
  }

  /**
   * A failed transfer: attachments go back to their entries in
   * the source, then the copies are deleted, in this order because the
   * server deletes the attachments of a deleted entry. If the way back
   * fails, the copies stay and keep the blobs.
   */
  async #undoMove(
    sourceId: string,
    destination: VaultState,
    copies: ItemRef[],
    moved: readonly { id: string; entry: string; target: string }[],
    icons: readonly string[],
  ): Promise<void> {
    try {
      for (const transfer of [...moved].reverse())
        await this.#access.api.transferAttachment(
          destination.id,
          transfer.id,
          sourceId,
          transfer.entry,
        );
      await this.#writeAll(
        destination,
        destroyIntents(this.#ops(destination), copies),
      );
      await this.#writeAll(
        destination,
        icons.flatMap((id): Intent[] => {
          const object = destination.objects.get(id);
          return object
            ? [{ kind: "delete", id, baseRevision: object.revision }]
            : [];
        }),
      );
    } catch {
      throw new SyncError("move_incomplete");
    }
  }

  #saveContext(state: VaultState): SaveContext {
    return {
      stamp: stamp(this.#access.userId),
      historyMaxItems: metaOf(state).historyMaxItems,
      newId: () => systemRandomness.id("field_id"),
    };
  }

  #sized<T>(build: () => T): T {
    try {
      return build();
    } catch (error) {
      if (error instanceof EntryTooLarge) throw new SyncError("too_large");
      throw error;
    }
  }

  #projection(state: VaultState): VaultProjection {
    let projection = this.#projections.get(state.id);
    if (!projection) {
      projection = new VaultProjection(state.id);
      this.#projections.set(state.id, projection);
    }
    return projection;
  }

  #ops(state: VaultState): Ops {
    return {
      state,
      projection: this.#projection(state),
      collator: this.#collator,
      stamp: () => stamp(this.#access.userId),
    };
  }

  /** An update of the current version of an object. */
  #update(
    state: VaultState,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<WriteResult> {
    const object = state.objects.get(id);
    if (!object) throw new SyncError("not_found");
    const local = applyObjectChange(
      object.raw,
      fields,
      stamp(this.#access.userId),
    );
    const intent: Intent = {
      kind: "update",
      id,
      baseRaw: object.raw,
      baseRevision: object.revision,
      local,
    };
    return this.#write(state, () => [intent]);
  }

  /** Static intents in batches of limited size, one after another. */
  async #writeAll(
    state: VaultState,
    intents: readonly Intent[],
  ): Promise<WriteResult> {
    const notices: Notice[] = [];
    for (const batch of chunks(intents, manifestCost(state))) {
      const result = await this.#write(state, () => batch);
      notices.push(...result.notices);
    }
    return { notices };
  }

  async #write(state: VaultState, plan: Plan): Promise<WriteResult> {
    // A vault without a manifest gets one before the user's change.
    await this.#ensureManifest(state);
    const operation = this.#operation(state, plan);
    const settle = () => {
      this.#emit();
      void this.pull(state.id);
    };
    const attempt = (pending?: Pending) =>
      state.lock.run(() =>
        pending ? operation.resend(pending) : operation.run(),
      );
    // A retry after a network error sends the same bytes.
    const wrap = (error: unknown): unknown => {
      if (!(error instanceof RetryableWrite)) return error;
      const pending = error.pending;
      return new SyncError("network", async () => {
        try {
          return await attempt(pending);
        } catch (next) {
          throw wrap(next);
        } finally {
          settle();
        }
      });
    };
    try {
      return await attempt();
    } catch (error) {
      throw wrap(error);
    } finally {
      settle();
    }
  }

  /** Read through a method: `stop()` may run while a task awaits. */
  #isStopped(): boolean {
    return this.#stopped;
  }

  #state(vaultId: string): VaultState {
    const state = this.#states.get(vaultId);
    if (!state) throw new SyncError("not_found");
    return state;
  }

  async #limit(task: () => Promise<void>): Promise<void> {
    while (this.#pulls >= MAX_PARALLEL_PULLS)
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#pulls++;
    try {
      await task();
    } finally {
      this.#pulls--;
      this.#waiting.shift()?.();
    }
  }

  async #refresh(): Promise<void> {
    if (this.#stopped) return;
    const access = this.#access;
    let summaries: VaultSummary[];
    try {
      summaries = await access.api.vaults();
      this.#error = undefined;
    } catch (error) {
      this.#error = error;
      this.#emit();
      return;
    }
    if (this.#isStopped()) return;
    // Own attestations are floors, whatever their age, before anything is
    // accepted or synced.
    await this.#applyAttestations(summaries);
    if (this.#isStopped()) return;
    const marks = await access.marks.read(access.userId);
    const active = summaries.filter((s) => s.state === "active");
    this.#invitations = await Promise.all(
      summaries
        .filter((s) => s.state === "pending")
        .map((summary) => this.#invitation(summary)),
    );
    if (this.#isStopped()) return;
    const ids = new Set(active.map((s) => s.vault_id));
    for (const id of [...this.#states.keys()]) {
      if (ids.has(id)) continue;
      // Gone from the list: dropped from the view; the marks stay.
      this.#states.delete(id);
      this.#projections.delete(id);
      access.keys.forgetVault(id);
    }
    for (const summary of active) {
      const id = summary.vault_id;
      let state = this.#states.get(id);
      const seen = marks.vaults[id];
      if (!state) {
        state = new VaultState(summary);
        // Marks from before confirmation times: the first check confirms.
        state.transition = seen !== undefined && seen.ft === undefined;
        this.#states.set(id, state);
      }
      state.confirmedAt = Math.max(state.confirmedAt, seen?.ft ?? 0);
      state.summary = summary;
      this.#unwrapKey(state);
      state.keyFloor = Math.max(state.keyFloor, seen?.kv ?? 0);
      // An older revision or key version: the server played back an older
      // state (with the old key, a removed member could read new writes).
      if (
        (seen && summary.revision < seen.rev) ||
        summary.vault_key_version < state.keyFloor
      )
        state.rollback = true;
    }
    // The roles chain first: a pending key is accepted only against it.
    const roles = await this.#rolesSupported();
    for (const state of this.#states.values())
      await this.#updateRoles(state, marks, roles);
    if (roles) await this.#roles.flush();
    for (const state of this.#states.values())
      await this.#checkKey(state, marks.vaults[state.id]?.ow ?? []);
    if (this.#isStopped()) return;
    // Only with the current key: owners shown next to a pending key could
    // be made up for exactly that key.
    await Promise.all(
      [...this.#states.values()]
        .filter((s) => s.keyStatus === "ok" && s.summary.pending_key === null)
        .map((s) => this.#rememberOwners(s)),
    );
    if (this.#isStopped()) return;
    if (roles && (await this.#ownerDuties())) void this.refresh();
    if (this.#isStopped()) return;
    this.#loaded = true;
    this.#emit();
    await Promise.all(
      [...this.#states.values()]
        .filter(
          (s) =>
            s.keyOk &&
            s.keyStatus === "ok" &&
            (!s.synced || s.summary.revision !== s.since),
        )
        .map((s) => this.pull(s.id)),
    );
    if (this.#isStopped()) return;
    // A vault without a new revision is checked again too: an attestation
    // may have arrived, or the period passed.
    const settled = [...this.#states.values()].filter(
      (s) => s.synced && s.keyStatus === "ok",
    );
    for (const state of settled) this.#evaluate(state);
    this.#emit();
    await Promise.all(settled.map((s) => this.#attest(s)));
  }

  /** The sender's public key, cached for the session. */
  async #publicUser(userId: string): Promise<PublicUser | undefined> {
    const known = this.#publicUsers.get(userId);
    if (known !== undefined) return known ?? undefined;
    try {
      const user = await this.#access.api.publicKey(userId);
      this.#publicUsers.set(userId, user);
      return user;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        this.#publicUsers.set(userId, null);
      return undefined;
    }
  }

  #candidate(user: PublicUser): Candidate {
    return toCandidate(user, this.#access.contacts(), this.#access.userId);
  }

  async #invitation(summary: VaultSummary): Promise<Invitation> {
    const grant = summary.invitation;
    const sender = grant ? await this.#publicUser(grant.sender_id) : undefined;
    return {
      summary,
      sender,
      vaultName:
        grant && sender
          ? grantName(
              this.#access,
              summary.vault_id,
              grant,
              this.#candidate(sender),
            )
          : undefined,
    };
  }

  /**
   * The roles chain of a vault, loaded when the vault list names another
   * head; a key version below the chain's is a rollback.
   */
  async #updateRoles(
    state: VaultState,
    marks: UserMarks,
    supported: boolean,
  ): Promise<void> {
    const version = state.summary.roles_version;
    if (!supported || version === undefined) {
      // A server that hides the chain of an anchored vault does not get the
      // older rules back: that is a rollback.
      const anchor =
        this.#access.roleAnchor(state.id) ??
        (marks.vaults[state.id]?.rl ||
        this.#freshness.rolePoints(state.id).length > 0
          ? { owners: [] }
          : undefined);
      state.roles = anchor
        ? {
            version: null,
            status: "rollback",
            statements: [],
            head: undefined,
            anchor: undefined,
            deliveredOwners: [],
            verifyOwners: false,
          }
        : undefined;
      return;
    }
    try {
      state.roles = await this.#roles.update(
        state.id,
        version,
        marks.vaults[state.id]?.ow,
        this.#freshness.rolePoints(state.id),
      );
    } catch (error) {
      if (error instanceof CryptoError && error.code === "locked") throw error;
      state.error = error;
    }
    const head = state.roles?.status === "ok" ? state.roles.head : undefined;
    if (head) {
      state.keyFloor = Math.max(state.keyFloor, head.statement.keyVersion);
      if (state.summary.vault_key_version < state.keyFloor)
        state.rollback = true;
    }
  }

  /**
   * Owners start a chain for older vaults and drop departed owners from it;
   * `true` if the chain changed.
   */
  async #ownerDuties(): Promise<boolean> {
    let changed = false;
    for (const state of this.#states.values()) {
      if (
        state.summary.role !== "owner" ||
        state.keyStatus !== "ok" ||
        state.rollback ||
        !state.roles ||
        !this.#confirmed(state)
      )
        continue;
      try {
        if (
          await this.#roles.ownerDuties(
            state.id,
            state.summary.vault_key_version,
            state.members,
          )
        )
          changed = true;
        state.roles = this.#roles.get(state.id) ?? state.roles;
      } catch (error) {
        if (error instanceof CryptoError && error.code === "locked")
          throw error;
      }
    }
    return changed;
  }

  /**
   * Remembers the owners of a vault whose current key this device holds:
   * only the own account if it is the only member, else the active owners
   * of the member list, which also stays for the roles checks. A failed
   * request keeps the remembered ones.
   */
  async #rememberOwners(state: VaultState): Promise<void> {
    const { summary } = state;
    const access = this.#access;
    const head = state.roles?.status === "ok" ? state.roles.head : undefined;
    const othersInChain = head?.statement.owners.some(
      (o) => o.userId !== access.userId,
    );
    let owners: string[];
    if (summary.member_count <= 1 && !othersInChain) {
      state.members = undefined;
      owners = summary.role === "owner" ? [access.userId] : [];
    } else {
      let members: Member[];
      try {
        members = await access.api.members(state.id);
      } catch {
        return;
      }
      state.members = members;
      owners = members
        .filter((m) => m.role === "owner" && m.state === "active")
        .map((m) => m.user_id);
    }
    await this.#context.marks.rememberOwners(access.userId, state.id, owners);
  }

  /**
   * The key of the current version: a pending key from a verified contact
   * who is a remembered owner is accepted without asking, otherwise the
   * vault waits for the user.
   */
  async #checkKey(state: VaultState, owners: readonly string[]): Promise<void> {
    const summary = state.summary;
    state.pendingSender = undefined;
    state.pendingReason = undefined;
    if (this.#access.keys.hasVaultKey(state.id, summary.vault_key_version)) {
      state.keyStatus = "ok";
      return;
    }
    const pending = summary.pending_key;
    if (!pending || pending.key_version !== summary.vault_key_version) {
      state.keyStatus = "missing";
      return;
    }
    const user = await this.#publicUser(pending.sender_id);
    if (!user) {
      state.keyStatus = "pending";
      return;
    }
    const sender = this.#candidate(user);
    const roles = state.roles;
    const chained = roles !== undefined && roles.status !== "none";
    const waiting =
      sender.status !== "verified"
        ? "unverified"
        : !chained
          ? owners.includes(sender.userId)
            ? undefined
            : "unknown_owner"
          : roles.status === "ok"
            ? undefined
            : roles.status === "unanchored"
              ? "roles_unconfirmed"
              : "roles_invalid";
    // A device with an unconfirmed state might be shown a forked chain
    // that commits to a former owner's key.
    const reason = waiting ?? (this.#confirmed(state) ? undefined : "stale");
    if (reason) {
      state.keyStatus = "pending";
      state.pendingSender = sender;
      state.pendingReason = reason;
      return;
    }
    try {
      await acceptGrant(
        this.#access,
        "key",
        summary,
        sender,
        this.#keyChecks(state, pending.key_version, {
          owners,
          confirmed: false,
        }),
      );
      state.keyStatus = "ok";
      state.summary = {
        ...summary,
        member_key_version: pending.key_version,
        pending_key: null,
      };
    } catch (error) {
      if (error instanceof CryptoError && error.code === "locked") throw error;
      const code = error instanceof SyncError ? error.code : undefined;
      state.keyStatus =
        code === "key_box_invalid" || code === "roles_rejected"
          ? "invalid"
          : "pending";
      if (code === "roles_rejected" || code === "roles_invalid")
        state.pendingReason = code;
      state.pendingSender = sender;
    }
  }

  #unwrapKey(state: VaultState): void {
    const { summary } = state;
    const access = this.#access;
    if (access.keys.hasVaultKey(state.id, summary.member_key_version)) return;
    const wrapped = summary.key_wrapped;
    if (wrapped === null) {
      state.keyOk = false;
      return;
    }
    try {
      const key = access.keys.useUserKey((userKey) =>
        unwrapVaultKey(
          userKey,
          wrapped,
          state.id,
          access.userId,
          summary.member_key_version,
        ),
      );
      access.keys.setVaultKey(state.id, summary.member_key_version, key);
      state.keyOk = true;
    } catch (error) {
      if (error instanceof CryptoError && error.code === "locked") throw error;
      state.keyOk = false;
    }
  }

  #onEvent(event: ServerEvent): void {
    if (this.#stopped) return;
    switch (event.type) {
      case "vault_changed": {
        const state = this.#states.get(event.vaultId);
        if (!state) void this.refresh();
        // Without the current key the vault is not synced.
        else if (state.keyStatus === "ok" && event.revision > state.since)
          void this.pull(state.id);
        break;
      }
      case "vaults_changed":
        void this.refresh();
        break;
      case "user_data_changed":
        void this.#access
          .reloadUserData(event.revision)
          .then(() => {
            this.#options.onUserDataChanged?.();
            this.contactsChanged();
          })
          .catch(() => undefined);
        break;
    }
  }

  /** Marks the projection stale; listeners hear once per microtask. */
  #emit(): void {
    if (this.#stopped) return;
    this.#snapshot = undefined;
    if (this.#notifying) return;
    this.#notifying = true;
    queueMicrotask(() => {
      this.#notifying = false;
      if (this.#stopped) return;
      const snapshot = this.snapshot;
      for (const listener of this.#listeners) listener(snapshot);
    });
  }

  // ------------------------------------------------------------ freshness

  #freshnessSupported(): Promise<boolean> {
    this.#freshnessFeature ??= this.#access.api.config().then(
      (config) => config.features.freshness === true,
      () => {
        this.#freshnessFeature = undefined;
        return false;
      },
    );
    return this.#freshnessFeature;
  }

  #periodMs(): number {
    return this.#access.freshnessPeriodDays() * DAY_MS;
  }

  /** What the server delivered, as far as an attestation speaks about it. */
  #delivered(state: VaultState, withRoot: boolean): DeliveredState {
    let root: DeliveredState["root"];
    if (withRoot) {
      const current = currentRoot(state);
      const hash = state.served.get(manifestIds(state.id).root)?.hash;
      root = current && hash ? { seq: current.entry.seq, hash } : null;
    }
    return {
      keyVersion: state.summary.vault_key_version,
      root,
      roles: state.roles?.status === "ok" ? state.roles.statements : undefined,
    };
  }

  /**
   * Before a sync: confirmed by this device or by an own attestation the
   * delivered key version and roles chain meet, within the period.
   */
  #confirmed(state: VaultState): boolean {
    if (state.transition || state.freshness?.status === "fresh") return true;
    const now = this.#access.now();
    const basis = confirmationBasis(
      state.confirmedAt,
      this.#freshness.attestation(state.id),
      this.#delivered(state, false),
      now,
    );
    return basis > 0 && basis >= now - this.#periodMs();
  }

  /** After a sync: confirms the vault or marks it stale; no network. */
  #evaluate(state: VaultState): void {
    if (this.#stopped || !state.synced || !state.keyOk) return;
    const now = this.#access.now();
    const basis = state.transition
      ? now
      : confirmationBasis(
          state.confirmedAt,
          this.#freshness.attestation(state.id),
          this.#delivered(state, true),
          now,
        );
    state.transition = false;
    const fresh = basis > 0 && basis >= now - this.#periodMs();
    if (!fresh) {
      state.freshness = {
        status: "stale",
        since: basis > 0 ? basis : undefined,
      };
      return;
    }
    state.confirmedAt = now;
    state.freshness = { status: "fresh", since: now };
    void this.#context.marks
      .raise(this.#access.userId, {
        vaults: { [state.id]: { rev: 0, obj: {}, ft: now } },
      })
      .catch(() => undefined);
  }

  #rollbackOpen(state: VaultState): boolean {
    return (
      state.rollback ||
      state.rollbackDeletes.size > 0 ||
      [...state.objects.values()].some((o) => o.rollback)
    );
  }

  /** Only a confirmed vault without any warning is signed. */
  #signable(state: VaultState): boolean {
    const { summary } = state;
    const roles = state.roles?.status;
    return (
      !this.#stopped &&
      state.freshness?.status === "fresh" &&
      state.synced &&
      state.keyOk &&
      state.keyStatus === "ok" &&
      summary.member_key_version === summary.vault_key_version &&
      !this.#rollbackOpen(state) &&
      (state.manifest.status === "verified" ||
        state.manifest.status === "unverified") &&
      (roles === undefined || roles === "ok" || roles === "none")
    );
  }

  #statement(state: VaultState): VaultFreshness {
    const root = currentRoot(state);
    const rootHash = state.manifest.rootHash;
    const head = state.roles?.status === "ok" ? state.roles.head : undefined;
    return {
      type: "vault_freshness",
      vaultId: state.id,
      userId: this.#access.userId,
      time: new Date(this.#access.now()).toISOString(),
      keyVersion: state.summary.vault_key_version,
      manifest:
        state.manifest.status === "verified" && root && rootHash
          ? { seq: root.entry.seq, hash: rootHash }
          : null,
      roles: head ? { version: head.statement.version, hash: head.hash } : null,
    };
  }

  /** Offers the vault's attestation; nothing for a vault with a warning. */
  async #attest(state: VaultState): Promise<void> {
    if (!this.#signable(state)) return;
    try {
      await this.#freshness.offer(state.id, () =>
        this.#signable(state) ? this.#statement(state) : undefined,
      );
    } catch (error) {
      if (error instanceof CryptoError && error.code === "locked") return;
      throw error;
    }
  }

  /** Raises the floors of the own attestations of the vault list. */
  async #applyAttestations(summaries: readonly VaultSummary[]): Promise<void> {
    const attested = this.#freshness.take(summaries);
    if (attested.size === 0) return;
    const vaults: UserMarks["vaults"] = {};
    for (const [id, attestation] of attested)
      vaults[id] = {
        rev: 0,
        obj: {},
        kv: attestation.keyVersion,
        ...(attestation.manifest ? { mf: attestation.manifest.seq } : {}),
        // Not a confirmation: only the field, so no transition is assumed.
        ft: 0,
      };
    await this.#context.marks.raise(this.#access.userId, { vaults });
  }

  #requireConfirmed(state: VaultState): void {
    if (!this.#confirmed(state)) throw new SyncError("stale");
  }

  /**
   * "Understood": the delivered state of the vault (or of every stale
   * vault) counts as confirmed now, and the device signs it again.
   */
  async acknowledgeFreshness(vaultId?: string): Promise<void> {
    const states =
      vaultId === undefined
        ? [...this.#states.values()].filter(
            (s) => s.freshness?.status === "stale",
          )
        : [this.#state(vaultId)];
    const now = this.#access.now();
    for (const state of states) {
      state.confirmedAt = now;
      await this.#context.marks.raise(this.#access.userId, {
        vaults: { [state.id]: { rev: 0, obj: {}, ft: now } },
      });
      this.#evaluate(state);
    }
    this.#emit();
    await Promise.all(states.map((s) => this.#attest(s)));
  }

  /**
   * After a pairing raised the marks: roles points to check the chains
   * against, and a full sync of every vault against the new floors.
   */
  async afterPairing(
    rolePoints: ReadonlyMap<string, RolePoint>,
  ): Promise<void> {
    for (const [id, point] of rolePoints)
      this.#freshness.rememberPaired(id, point);
    for (const state of this.#states.values()) {
      state.synced = false;
      state.freshness = undefined;
    }
    await this.refresh();
  }

  #scheduleTick(): void {
    if (this.#stopped) return;
    const timers = this.#options.timers ?? systemTimers;
    this.#tick = timers.setTimeout(() => {
      this.#tick = undefined;
      if (this.#stopped) return;
      void this.refresh();
      void this.#access.attestUserData().catch(() => undefined);
      this.#scheduleTick();
    }, RENEW_AFTER_MS);
  }

  #build(): SyncSnapshot {
    const order = this.#access.vaultOrder();
    const position = (id: string) => {
      const index = order.indexOf(id);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    const states = [...this.#states.values()].sort(
      (a, b) =>
        position(a.id) - position(b.id) ||
        a.summary.created.localeCompare(b.summary.created) ||
        a.id.localeCompare(b.id),
    );
    const vaults: VaultView[] = states.map((state) =>
      this.#projection(state).view(state, this.#collator),
    );
    const invitations = this.#invitations.map(
      ({ summary, sender, vaultName }) => ({
        vaultId: summary.vault_id,
        keyVersion: summary.invitation?.key_version ?? 0,
        senderId: summary.invitation?.sender_id ?? "",
        sender: sender ? this.#candidate(sender) : undefined,
        vaultName,
      }),
    );
    return {
      loaded: this.#loaded,
      invitations,
      connection: this.#connection,
      marksLimited: this.#marksLimited,
      error: this.#error,
      vaults,
      clockOffset: this.#clock.offset,
    };
  }
}

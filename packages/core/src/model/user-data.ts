/**
 * user_data: defaults, validation and the three-way merge after
 * `409 conflict`. The raw JSON stays the source of truth so unknown fields
 * survive; only known places of a copy are changed.
 */
import * as v from "valibot";
import { fromBase64Url, isJsonObject, type JsonObject } from "../crypto/bytes";
import { isTimestamp } from "../crypto/time";
import { UUID_PATTERN } from "../crypto/uuid";
import {
  GENERATOR_DEFAULTS,
  generatorOptionsOf,
  isGeneratorOptions,
  type GeneratorOptions,
} from "../generator/options";
import { FORBIDDEN_SCHEMES } from "../placeholders/resolve";
import { clone, own, same, seqOf, setOwn } from "./json";

export const USER_DATA_SCHEMA = 1;

export const LANGUAGES = ["de", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Settings {
  /** `undefined`: the device language applies. */
  language: Language | undefined;
  autoLockMinutes: number;
  lockOnHiddenMinutes: number | null;
  clipboardClearSeconds: number | null;
  /** Schemes that may be opened, besides the forbidden ones. */
  allowedUrlSchemes: readonly string[];
  searchProtectedFields: boolean;
  /** The TOTP column of the entry list. */
  showTotpColumn: boolean;
  /** Each option falls back to its default on its own. */
  passwordGenerator: GeneratorOptions;
  /** Days within which a device of the account must have confirmed a state. */
  freshnessDays: number;
  /** Strict mode: attestations of other devices confirm nothing. */
  requireConfirmation: boolean;
}

export type SettingKey = keyof Settings;

export const SETTING_DEFAULTS: Settings = {
  language: undefined,
  autoLockMinutes: 15,
  lockOnHiddenMinutes: null,
  clipboardClearSeconds: 30,
  allowedUrlSchemes: ["http", "https"],
  searchProtectedFields: false,
  showTotpColumn: true,
  passwordGenerator: GENERATOR_DEFAULTS,
  freshnessDays: 7,
  requireConfirmation: false,
};

/** `undefined` removes the setting, i.e. returns to the default. */
export type SettingsChange = { [K in SettingKey]?: Settings[K] | undefined };

/** Verifying writes a contact, removing deletes it. */
export type ContactChange =
  | {
      kind: "verify";
      userId: string;
      email: string;
      fingerprint: string;
      /**
       * Fingerprint version 2, over both public keys; missing only where
       * the server knows no signing keys.
       */
      fingerprint2: string | undefined;
      verifiedAt: string;
    }
  | { kind: "remove"; userId: string };

/** The newest roles statement this account checked for a vault. */
export interface RoleAnchor {
  version: number;
  hash: string;
  /** Owner IDs of that statement, for the warning after a restore. */
  owners: readonly string[];
}

/** A state code of a member that contradicted this account's chain. */
export interface ComparisonPoint {
  version: number;
  /** 26 characters of Base32. */
  code: string;
  /** When it was stored. */
  at: string;
}

/** The last state code that matched, for display only. */
export interface ComparisonMatch {
  version: number;
  at: string;
  /** The member the user named as the other side. */
  partner: string | null;
}

export interface Comparisons {
  points: readonly ComparisonPoint[];
  match: ComparisonMatch | undefined;
}

export interface ComparisonChange {
  add?: readonly ComparisonPoint[];
  /** Points by version and code. */
  remove?: readonly { version: number; code: string }[];
  match?: ComparisonMatch;
}

/** At most this many comparison points per vault. */
export const COMPARISON_POINTS_MAX = 16;

export interface UserDataChange {
  settings?: SettingsChange;
  recoveryKeyConfirmed?: boolean;
  /** The order of all vaults known when the user sorts. */
  vaultOrder?: string[];
  contacts?: ContactChange[];
  /** New anchors by vault ID; `null` removes one. */
  roles?: Record<string, RoleAnchor | null>;
  /** Comparison results by vault ID. */
  compared?: Record<string, ComparisonChange>;
}

export type UserDataState =
  { status: "ok"; raw: JsonObject; readOnly: boolean } | { status: "corrupt" };

const PositiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

const ContactSchema = v.looseObject({
  userId: v.pipe(v.string(), v.regex(UUID_PATTERN)),
  email: v.string(),
  fingerprint: v.pipe(v.string(), v.regex(/^[0-9A-F]{64}$/)),
  // Any other value counts as a different fingerprint.
  fingerprint2: v.optional(v.unknown()),
  verifiedAt: v.string(),
  conflict: v.optional(v.boolean()),
});

const StructureSchema = v.looseObject({
  schema: PositiveInteger,
  seq: PositiveInteger,
  contacts: v.optional(v.array(ContactSchema)),
  // valibot's object schemas also accept arrays.
  settings: v.optional(v.custom<JsonObject>(isJsonObject)),
});

/** A verified contact; `conflict` marks it as unverified. */
export type Contact = v.InferOutput<typeof ContactSchema>;

const FINGERPRINT_PATTERN = /^[0-9A-F]{64}$/;

function isInteger(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/** Lowercase, unique and none of the forbidden ones. */
export function isUrlSchemeList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (scheme, index) =>
        typeof scheme === "string" &&
        /^[a-z][a-z0-9+.-]*$/.test(scheme) &&
        !FORBIDDEN_SCHEMES.includes(scheme) &&
        value.indexOf(scheme) === index,
    )
  );
}

const SETTING_RULES: { [K in SettingKey]: (value: unknown) => boolean } = {
  language: (value) => LANGUAGES.includes(value as Language),
  autoLockMinutes: (value) => isInteger(value, 1, 1440),
  lockOnHiddenMinutes: (value) => value === null || isInteger(value, 0, 1440),
  clipboardClearSeconds: (value) => value === null || isInteger(value, 5, 600),
  allowedUrlSchemes: isUrlSchemeList,
  searchProtectedFields: (value) => typeof value === "boolean",
  showTotpColumn: (value) => typeof value === "boolean",
  passwordGenerator: isGeneratorOptions,
  freshnessDays: (value) => isInteger(value, 1, 90),
  requireConfirmation: (value) => typeof value === "boolean",
};

function settingsOf(raw: JsonObject): JsonObject {
  const settings = own(raw, "settings");
  return isJsonObject(settings) ? settings : {};
}

/** The contacts of valid user_data (`inspectUserData` checked them). */
export function contactsOf(raw: JsonObject): readonly Contact[] {
  const contacts = own(raw, "contacts");
  return Array.isArray(contacts) ? (contacts as Contact[]) : [];
}

function applyContactChange(contacts: JsonObject[], change: ContactChange) {
  if (!UUID_PATTERN.test(change.userId))
    throw new Error("Invalid contact user ID");
  const index = contacts.findIndex((c) => own(c, "userId") === change.userId);
  if (change.kind === "remove") {
    if (index >= 0) contacts.splice(index, 1);
    return;
  }
  if (
    !FINGERPRINT_PATTERN.test(change.fingerprint) ||
    (change.fingerprint2 !== undefined &&
      !FINGERPRINT_PATTERN.test(change.fingerprint2))
  )
    throw new Error("Invalid contact fingerprint");
  // Unknown fields of an existing contact survive.
  const contact = index >= 0 ? clone(contacts[index] ?? {}) : {};
  setOwn(contact, "userId", change.userId);
  setOwn(contact, "email", change.email);
  setOwn(contact, "fingerprint", change.fingerprint);
  if (change.fingerprint2 === undefined)
    Reflect.deleteProperty(contact, "fingerprint2");
  else setOwn(contact, "fingerprint2", change.fingerprint2);
  setOwn(contact, "verifiedAt", change.verifiedAt);
  Reflect.deleteProperty(contact, "conflict");
  if (index >= 0) contacts[index] = contact;
  else contacts.push(contact);
}

/** Content written at registration. */
export function initialUserData(language: Language): JsonObject {
  return {
    schema: USER_DATA_SCHEMA,
    seq: 1,
    contacts: [],
    settings: { language },
    recoveryKeyConfirmed: false,
  };
}

/** Structural check; `undefined` means decryption failed. */
export function inspectUserData(
  content: JsonObject | undefined,
): UserDataState {
  if (content === undefined || !v.is(StructureSchema, content))
    return { status: "corrupt" };
  return {
    status: "ok",
    raw: content,
    readOnly: content.schema > USER_DATA_SCHEMA,
  };
}

/** Effective settings: out-of-range values fall back to the default. */
export function effectiveSettings(raw: JsonObject): Settings {
  const stored = settingsOf(raw);
  const read = <K extends SettingKey>(key: K): Settings[K] => {
    const value = own(stored, key);
    return SETTING_RULES[key](value)
      ? (value as Settings[K])
      : SETTING_DEFAULTS[key];
  };
  return {
    language: read("language"),
    autoLockMinutes: read("autoLockMinutes"),
    lockOnHiddenMinutes: read("lockOnHiddenMinutes"),
    clipboardClearSeconds: read("clipboardClearSeconds"),
    allowedUrlSchemes: read("allowedUrlSchemes"),
    searchProtectedFields: read("searchProtectedFields"),
    showTotpColumn: read("showTotpColumn"),
    passwordGenerator: generatorOptionsOf(own(stored, "passwordGenerator")),
    freshnessDays: read("freshnessDays"),
    requireConfirmation: read("requireConfirmation"),
  };
}

/** Valid vault IDs of `vaultOrder`; anything else is ignored. */
export function vaultOrderOf(raw: JsonObject): string[] {
  const order = own(raw, "vaultOrder");
  if (!Array.isArray(order)) return [];
  return order.filter(
    (id): id is string => typeof id === "string" && UUID_PATTERN.test(id),
  );
}

function isHash(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    fromBase64Url(value, 32);
    return true;
  } catch {
    return false;
  }
}

function anchorOf(value: unknown): RoleAnchor | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const [version, hash, owners] = value as unknown[];
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !isHash(hash) ||
    !Array.isArray(owners) ||
    !owners.every((id) => typeof id === "string" && UUID_PATTERN.test(id))
  )
    return undefined;
  return { version, hash, owners: [...(owners as string[])] };
}

function rolesOfRaw(raw: JsonObject): JsonObject {
  const roles = own(raw, "roles");
  return isJsonObject(roles) ? roles : {};
}

/** The valid anchor of a vault; an invalid entry counts as missing. */
export function roleAnchorOf(
  raw: JsonObject,
  vaultId: string,
): RoleAnchor | undefined {
  return anchorOf(own(rolesOfRaw(raw), vaultId));
}

const STATE_CODE = /^[A-Z2-7]{25}[AEIMQUY4]$/;

function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function pointOf(value: unknown): ComparisonPoint | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const [version, code, at] = value as unknown[];
  if (
    !isVersion(version) ||
    typeof code !== "string" ||
    !STATE_CODE.test(code) ||
    !isTimestamp(at)
  )
    return undefined;
  return { version, code, at };
}

function matchOf(value: unknown): ComparisonMatch | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const [version, at, partner] = value as unknown[];
  if (
    !isVersion(version) ||
    !isTimestamp(at) ||
    !(
      partner === null ||
      (typeof partner === "string" && UUID_PATTERN.test(partner))
    )
  )
    return undefined;
  return { version, at, partner };
}

function pointKey(point: { version: number; code: string }): string {
  return `${String(point.version)}:${point.code}`;
}

function comparedOfRaw(raw: JsonObject): JsonObject {
  const compared = own(raw, "compared");
  return isJsonObject(compared) ? compared : {};
}

/** The comparison results of a vault; invalid elements count as missing. */
export function comparisonsOf(raw: JsonObject, vaultId: string): Comparisons {
  const entry = own(comparedOfRaw(raw), vaultId);
  if (!isJsonObject(entry)) return { points: [], match: undefined };
  const list = own(entry, "points");
  const points = (Array.isArray(list) ? list : [])
    .map(pointOf)
    .filter((p): p is ComparisonPoint => p !== undefined);
  return { points, match: matchOf(own(entry, "match")) };
}

/**
 * Applies a change to the comparisons of one vault in place. Invalid
 * stored elements stay as they are; a point is kept once.
 */
function applyComparison(
  compared: JsonObject,
  vaultId: string,
  change: ComparisonChange,
  limit: boolean,
): void {
  if (!UUID_PATTERN.test(vaultId)) throw new Error("Invalid comparison");
  const current = own(compared, vaultId);
  const entry = isJsonObject(current) ? clone(current) : {};
  const list = own(entry, "points");
  const removed = new Set((change.remove ?? []).map(pointKey));
  const points = (Array.isArray(list) ? list : []).filter((item) => {
    const point = pointOf(item);
    return !point || !removed.has(pointKey(point));
  });
  for (const added of change.add ?? []) {
    const item = [added.version, added.code, added.at];
    if (!pointOf(item)) throw new Error("Invalid comparison point");
    const known = points.some((p) => {
      const point = pointOf(p);
      return point !== undefined && pointKey(point) === pointKey(added);
    });
    if (!known) points.push(item);
  }
  if (limit && points.filter((p) => pointOf(p)).length > COMPARISON_POINTS_MAX)
    throw new Error("Too many comparison points");
  setOwn(entry, "points", points);
  if (change.match) {
    const item = [change.match.version, change.match.at, change.match.partner];
    if (!matchOf(item)) throw new Error("Invalid comparison match");
    setOwn(entry, "match", item);
  }
  setOwn(compared, vaultId, entry);
}

/** A missing or invalid flag counts as confirmed. */
export function isRecoveryKeyConfirmed(raw: JsonObject): boolean {
  return own(raw, "recoveryKeyConfirmed") !== false;
}

/** A copy with the change applied and `seq` increased. */
export function applyUserDataChange(
  raw: JsonObject,
  change: UserDataChange,
): JsonObject {
  const next = clone(raw);
  if (change.settings) {
    const settings = clone(settingsOf(next));
    for (const [key, value] of Object.entries(change.settings) as [
      SettingKey,
      unknown,
    ][]) {
      if (!(key in SETTING_RULES)) throw new Error(`Unknown setting ${key}`);
      if (value === undefined) {
        Reflect.deleteProperty(settings, key);
      } else {
        if (!SETTING_RULES[key](value))
          throw new Error(`Invalid value for ${key}`);
        setOwn(settings, key, value);
      }
    }
    setOwn(next, "settings", settings);
  }
  if (change.recoveryKeyConfirmed !== undefined)
    setOwn(next, "recoveryKeyConfirmed", change.recoveryKeyConfirmed);
  if (change.vaultOrder !== undefined) {
    if (!change.vaultOrder.every((id) => UUID_PATTERN.test(id)))
      throw new Error("Invalid vault ID in vaultOrder");
    setOwn(next, "vaultOrder", [...change.vaultOrder]);
  }
  if (change.contacts !== undefined) {
    const contacts = contactsOf(next).map((c) => clone(c));
    for (const contactChange of change.contacts)
      applyContactChange(contacts, contactChange);
    setOwn(next, "contacts", contacts);
  }
  if (change.roles !== undefined) {
    const roles = clone(rolesOfRaw(next));
    for (const [vaultId, anchor] of Object.entries(change.roles)) {
      if (!UUID_PATTERN.test(vaultId)) throw new Error("Invalid roles anchor");
      if (anchor === null) {
        Reflect.deleteProperty(roles, vaultId);
        continue;
      }
      const entry = [anchor.version, anchor.hash, [...anchor.owners]];
      if (!anchorOf(entry)) throw new Error("Invalid roles anchor");
      setOwn(roles, vaultId, entry);
    }
    setOwn(next, "roles", roles);
  }
  if (change.compared !== undefined) {
    const compared = clone(comparedOfRaw(next));
    for (const [vaultId, entry] of Object.entries(change.compared))
      applyComparison(compared, vaultId, entry, true);
    setOwn(next, "compared", compared);
  }
  setOwn(next, "seq", seqOf(raw) + 1);
  return next;
}

/**
 * Contacts merged per `userId`: one side changed → its version;
 * both changed with the same fingerprint → the server's; otherwise the
 * changed or the server's version, marked as a conflict.
 */
function mergeContacts(
  base: JsonObject,
  local: JsonObject,
  server: JsonObject,
): JsonObject[] {
  const byId = (raw: JsonObject) =>
    new Map(contactsOf(raw).map((c) => [c.userId, c]));
  const baseContacts = byId(base);
  const localContacts = byId(local);
  const serverContacts = byId(server);
  const ids = [...serverContacts.keys()];
  for (const id of localContacts.keys()) if (!ids.includes(id)) ids.push(id);
  const merged: JsonObject[] = [];
  for (const id of ids) {
    const before = baseContacts.get(id);
    const mine = localContacts.get(id);
    const theirs = serverContacts.get(id);
    let result: Contact | undefined;
    let conflict = false;
    if (same(mine, before)) result = theirs;
    else if (same(theirs, before)) result = mine;
    else if (mine && theirs) {
      result = theirs;
      conflict =
        mine.fingerprint2 !== undefined && theirs.fingerprint2 !== undefined
          ? mine.fingerprint2 !== theirs.fingerprint2
          : mine.fingerprint !== theirs.fingerprint;
    } else {
      result = mine ?? theirs;
      conflict = result !== undefined;
    }
    if (!result) continue;
    const contact = clone(result);
    if (conflict) setOwn(contact, "conflict", true);
    merged.push(contact);
  }
  return merged;
}

/**
 * Anchors changed locally go in unless the server has a higher version; at
 * the same version with another hash the server's stays (a fork, which the
 * roles check then reports). A local removal stands while the server still
 * has the base's anchor.
 */
function mergeRoles(
  base: JsonObject,
  local: JsonObject,
  server: JsonObject,
): JsonObject {
  const merged = clone(rolesOfRaw(server));
  const before = rolesOfRaw(base);
  const mine = rolesOfRaw(local);
  for (const [vaultId, entry] of Object.entries(before))
    if (own(mine, vaultId) === undefined && same(own(merged, vaultId), entry))
      Reflect.deleteProperty(merged, vaultId);
  for (const [vaultId, entry] of Object.entries(mine)) {
    if (same(own(before, vaultId), entry)) continue;
    const mine = anchorOf(entry);
    if (!mine) continue;
    const theirs = anchorOf(own(merged, vaultId));
    if (theirs && theirs.version >= mine.version) continue;
    setOwn(merged, vaultId, [mine.version, mine.hash, [...mine.owners]]);
  }
  return merged;
}

/**
 * Comparison points as a set: the server's, plus those added locally,
 * minus those removed locally (an "understood" removes only the points
 * this device knew). The later match wins.
 */
function mergeComparisons(
  base: JsonObject,
  local: JsonObject,
  server: JsonObject,
): JsonObject {
  const merged = clone(comparedOfRaw(server));
  const ids = new Set([
    ...Object.keys(comparedOfRaw(base)),
    ...Object.keys(comparedOfRaw(local)),
  ]);
  for (const vaultId of ids) {
    if (!UUID_PATTERN.test(vaultId)) continue;
    const before = comparisonsOf(base, vaultId);
    const mine = comparisonsOf(local, vaultId);
    const theirs = comparisonsOf(server, vaultId);
    const had = new Set(before.points.map(pointKey));
    const has = new Set(mine.points.map(pointKey));
    const add = mine.points.filter((p) => !had.has(pointKey(p)));
    const remove = before.points.filter((p) => !has.has(pointKey(p)));
    const match =
      mine.match &&
      (!theirs.match || Date.parse(mine.match.at) > Date.parse(theirs.match.at))
        ? mine.match
        : undefined;
    if (add.length === 0 && remove.length === 0 && !match) continue;
    applyComparison(merged, vaultId, { add, remove, match }, false);
  }
  return merged;
}

/**
 * Three-way merge: the server copy plus the local changes against
 * the base; settings, the recovery key flag and the vault order: the local
 * change wins; contacts are merged per contact, roles anchors per vault.
 */
export function mergeUserData(
  base: JsonObject,
  local: JsonObject,
  server: JsonObject,
): JsonObject {
  const merged = clone(server);

  const baseSettings = settingsOf(base);
  const localSettings = settingsOf(local);
  const settings = clone(settingsOf(merged));
  const keys = new Set([
    ...Object.keys(baseSettings),
    ...Object.keys(localSettings),
  ]);
  for (const key of keys) {
    const before = own(baseSettings, key);
    const after = own(localSettings, key);
    if (same(before, after)) continue;
    if (after === undefined) Reflect.deleteProperty(settings, key);
    else setOwn(settings, key, after);
  }
  setOwn(merged, "settings", settings);

  const confirmed = own(local, "recoveryKeyConfirmed");
  if (!same(own(base, "recoveryKeyConfirmed"), confirmed)) {
    if (confirmed === undefined)
      Reflect.deleteProperty(merged, "recoveryKeyConfirmed");
    else setOwn(merged, "recoveryKeyConfirmed", confirmed);
  }

  // A changed vault order wins as a whole.
  const order = own(local, "vaultOrder");
  if (!same(own(base, "vaultOrder"), order)) {
    if (order === undefined) Reflect.deleteProperty(merged, "vaultOrder");
    else setOwn(merged, "vaultOrder", order);
  }

  setOwn(merged, "contacts", mergeContacts(base, local, server));
  if (own(local, "roles") !== undefined || own(server, "roles") !== undefined)
    setOwn(merged, "roles", mergeRoles(base, local, server));
  if (
    own(local, "compared") !== undefined ||
    own(server, "compared") !== undefined
  )
    setOwn(merged, "compared", mergeComparisons(base, local, server));

  setOwn(merged, "seq", Math.max(seqOf(base), seqOf(server)) + 1);
  return merged;
}

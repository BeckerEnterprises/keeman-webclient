/**
 * user_data: defaults, validation and the three-way merge after
 * `409 conflict`. The raw JSON stays the source of truth so unknown fields
 * survive; only known places of a copy are changed.
 */
import * as v from "valibot";
import { isJsonObject, type JsonObject } from "../crypto/bytes";
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
      verifiedAt: string;
    }
  | { kind: "remove"; userId: string };

export interface UserDataChange {
  settings?: SettingsChange;
  recoveryKeyConfirmed?: boolean;
  /** The order of all vaults known when the user sorts. */
  vaultOrder?: string[];
  contacts?: ContactChange[];
}

export type UserDataState =
  { status: "ok"; raw: JsonObject; readOnly: boolean } | { status: "corrupt" };

const PositiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

const ContactSchema = v.looseObject({
  userId: v.pipe(v.string(), v.regex(UUID_PATTERN)),
  email: v.string(),
  fingerprint: v.pipe(v.string(), v.regex(/^[0-9A-F]{64}$/)),
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
  if (!FINGERPRINT_PATTERN.test(change.fingerprint))
    throw new Error("Invalid contact fingerprint");
  // Unknown fields of an existing contact survive.
  const contact = index >= 0 ? clone(contacts[index] ?? {}) : {};
  setOwn(contact, "userId", change.userId);
  setOwn(contact, "email", change.email);
  setOwn(contact, "fingerprint", change.fingerprint);
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
      conflict = mine.fingerprint !== theirs.fingerprint;
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
 * Three-way merge: the server copy plus the local changes against
 * the base; settings, the recovery key flag and the vault order: the local
 * change wins; contacts are merged per contact.
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

  setOwn(merged, "seq", Math.max(seqOf(base), seqOf(server)) + 1);
  return merged;
}

/**
 * Reading KDBX files in the worker: the header is checked before
 * any key derivation, so unsupported ciphers and oversized KDF parameters
 * fail fast; library errors become our own codes.
 */
import * as kdbxweb from "kdbxweb";
import {
  KDBX_LIMITS,
  KdbxError,
  type KdbxEntryFile,
  type KdbxEntryState,
  type KdbxFile,
  type KdbxGroupFile,
  type KdbxHeaderInfo,
  type KdbxIgnoredKind,
  type KdbxTimes,
} from "../types";
import { kdbxArgon2 } from "./argon2";
import { hexOfUuid } from "./uuid";

kdbxweb.CryptoEngine.setArgon2Impl(kdbxArgon2);

const { CipherId, KdfId, ErrorCodes } = kdbxweb.Consts;
const PUBLIC_COLOR = "KPXC_PUBLIC_COLOR";

function base64OfBytes(value: unknown): string | null {
  return value instanceof ArrayBuffer
    ? kdbxweb.ByteUtils.bytesToBase64(value)
    : null;
}

function numberOf(value: unknown): number | null {
  if (value instanceof kdbxweb.Int64) return value.value;
  return typeof value === "number" ? value : null;
}

/**
 * Maps kdbxweb errors to our codes; never keeps their messages. Other
 * errors while parsing mean a damaged file, except `RangeError` (memory).
 */
export function kdbxErrorOf(error: unknown): KdbxError {
  if (error instanceof KdbxError) return error;
  if (!(error instanceof kdbxweb.KdbxError))
    return new KdbxError(
      error instanceof Error && !(error instanceof RangeError)
        ? "corrupt"
        : "failed",
    );
  const message = error.message.toLowerCase();
  switch (error.code) {
    case ErrorCodes.BadSignature:
      return new KdbxError("not_kdbx");
    case ErrorCodes.InvalidVersion:
      return new KdbxError("unsupported_version");
    case ErrorCodes.InvalidKey:
      return new KdbxError("wrong_key");
    case ErrorCodes.Unsupported:
      if (message.includes("cipher"))
        return new KdbxError("unsupported_cipher");
      if (/kdf|argon2/.test(message)) return new KdbxError("unsupported_kdf");
      return new KdbxError("corrupt");
    default:
      // A key file kdbxweb cannot use is a wrong key file, not a broken database.
      return new KdbxError(/key ?file/.test(message) ? "wrong_key" : "corrupt");
  }
}

/**
 * Checks signature, version, cipher and KDF without deriving keys.
 * Throws `KdbxError`.
 */
export function inspectKdbxHeader(data: ArrayBuffer): KdbxHeaderInfo {
  if (data.byteLength > KDBX_LIMITS.fileBytes) throw new KdbxError("too_large");
  let header: kdbxweb.KdbxHeader;
  try {
    header = kdbxweb.KdbxHeader.read(
      new kdbxweb.BinaryStream(data),
      new kdbxweb.KdbxContext({ kdbx: new kdbxweb.Kdbx() }),
    );
  } catch (error) {
    throw kdbxErrorOf(error);
  }
  const cipherId = header.dataCipherUuid?.toString();
  const cipher =
    cipherId === CipherId.Aes
      ? "aes"
      : cipherId === CipherId.ChaCha20
        ? "chacha20"
        : null;
  if (cipher === null) throw new KdbxError("unsupported_cipher");
  const version = `${String(header.versionMajor)}.${String(header.versionMinor)}`;
  if (header.versionMajor < 4)
    return { version, cipher, kdf: "aes", memoryBytes: null };

  const params = header.kdfParameters;
  const kdfId = base64OfBytes(params?.get("$UUID"));
  if (kdfId === KdfId.Aes)
    return { version, cipher, kdf: "aes", memoryBytes: null };
  if (kdfId !== KdfId.Argon2d && kdfId !== KdfId.Argon2id)
    throw new KdbxError("unsupported_kdf");
  if (numberOf(params?.get("V")) !== 0x13)
    throw new KdbxError("unsupported_kdf");
  const memoryBytes = numberOf(params?.get("M"));
  if (memoryBytes === null) throw new KdbxError("corrupt");
  if (memoryBytes > KDBX_LIMITS.argon2MemoryBytes)
    throw new KdbxError("kdf_limits");
  return {
    version,
    cipher,
    kdf: kdfId === KdfId.Argon2id ? "argon2id" : "argon2d",
    memoryBytes,
  };
}

function isoOf(date: Date | undefined): string | null {
  if (date === undefined) return null;
  const time = date.getTime();
  // Years 1–9999 only, the range of the timestamp format.
  if (
    !Number.isFinite(time) ||
    time < -62135596800000 ||
    time > 253402300799999
  )
    return null;
  return date.toISOString();
}

function timesOf(times: kdbxweb.KdbxTimes): KdbxTimes {
  return {
    created: isoOf(times.creationTime),
    modified: isoOf(times.lastModTime),
    expires: times.expires === true ? isoOf(times.expiryTime) : null,
  };
}

function uuidOrNull(uuid: kdbxweb.KdbxUuid | undefined): string | null {
  return uuid === undefined || uuid.empty ? null : hexOfUuid(uuid);
}

type Ignored = Record<KdbxIgnoredKind, number>;

/** The binaries of a file, each content once: by hash, else by object. */
class BinaryPool {
  readonly list: Uint8Array[] = [];
  readonly #index = new Map<unknown, number>();

  add(binary: kdbxweb.KdbxBinary | kdbxweb.KdbxBinaryWithHash): number {
    const withHash = kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary);
    const key = withHash ? binary.hash : binary;
    const known = this.#index.get(key);
    if (known !== undefined) return known;
    const value = withHash ? binary.value : binary;
    // An own buffer each, so it can be transferred.
    const bytes =
      value instanceof kdbxweb.ProtectedValue
        ? value.getBinary()
        : new Uint8Array(value).slice();
    this.list.push(bytes);
    this.#index.set(key, this.list.length - 1);
    return this.list.length - 1;
  }
}

function customIconOf(uuid: kdbxweb.KdbxUuid | undefined): string | null {
  return uuid === undefined || uuid.empty ? null : hexOfUuid(uuid);
}

/** UUIDs of the custom icons a group, its entries and their history use. */
function usedIcons(group: KdbxGroupFile, used: Set<string>): Set<string> {
  if (group.customIcon !== null) used.add(group.customIcon);
  for (const entry of group.entries)
    for (const state of [entry, ...entry.history])
      if (state.customIcon !== null) used.add(state.customIcon);
  for (const child of group.groups) usedIcons(child, used);
  return used;
}

function entryState(
  entry: kdbxweb.KdbxEntry,
  pool: BinaryPool,
): KdbxEntryState {
  return {
    uuid: hexOfUuid(entry.uuid),
    icon: entry.icon ?? null,
    customIcon: customIconOf(entry.customIcon),
    strings: [...entry.fields].map(([key, value]) =>
      value instanceof kdbxweb.ProtectedValue
        ? { key, value: value.getText(), protected: true }
        : { key, value, protected: false },
    ),
    tags: [...entry.tags],
    times: timesOf(entry.times),
    attachments: [...entry.binaries].map(([name, binary]) => ({
      name,
      binary: pool.add(binary),
    })),
    previousParent: uuidOrNull(entry.previousParentGroup),
  };
}

function entryFile(
  entry: kdbxweb.KdbxEntry,
  ignored: Ignored,
  pool: BinaryPool,
): KdbxEntryFile {
  const autoType = entry.autoType;
  if (
    autoType.items.length > 0 ||
    !autoType.enabled ||
    (autoType.defaultSequence ?? "") !== ""
  )
    ignored.autoType++;
  if ((entry.customData?.size ?? 0) > 0) ignored.customData++;
  if ((entry.fgColor ?? "") !== "" || (entry.bgColor ?? "") !== "")
    ignored.colors++;
  if ((entry.overrideUrl ?? "") !== "") ignored.overrideUrl++;
  if (entry.qualityCheck === false) ignored.qualityCheck++;
  return {
    ...entryState(entry, pool),
    history: entry.history.map((state) => entryState(state, pool)),
  };
}

function groupFile(
  group: kdbxweb.KdbxGroup,
  ignored: Ignored,
  pool: BinaryPool,
): KdbxGroupFile {
  if (
    group.enableAutoType != null ||
    group.enableSearching != null ||
    (group.defaultAutoTypeSeq ?? "") !== "" ||
    group.times.expires === true ||
    group.tags.length > 0
  )
    ignored.groupSettings++;
  if ((group.customData?.size ?? 0) > 0) ignored.customData++;
  return {
    uuid: hexOfUuid(group.uuid),
    name: group.name ?? "",
    notes: group.notes ?? "",
    icon: group.icon ?? null,
    customIcon: customIconOf(group.customIcon),
    times: timesOf(group.times),
    previousParent: uuidOrNull(group.previousParentGroup),
    groups: group.groups.map((child) => groupFile(child, ignored, pool)),
    entries: group.entries.map((entry) => entryFile(entry, ignored, pool)),
  };
}

/** Converts a loaded database into the plain model. */
export function fileOf(db: kdbxweb.Kdbx, header: KdbxHeaderInfo): KdbxFile {
  const [first, ...extra] = db.groups;
  if (first === undefined) throw new KdbxError("corrupt");
  const ignored: Ignored = {
    autoType: 0,
    customData: db.meta.customData.size > 0 ? 1 : 0,
    colors: 0,
    overrideUrl: 0,
    qualityCheck: 0,
    groupSettings: 0,
    deletedObjects: db.deletedObjects.length,
    publicCustomData: 0,
  };
  const publicData = db.header.publicCustomData;
  const publicColor = publicData?.get(PUBLIC_COLOR);
  ignored.publicCustomData = (publicData?.keys() ?? []).filter(
    (key) => key !== PUBLIC_COLOR,
  ).length;
  const pool = new BinaryPool();
  const root = groupFile(first, ignored, pool);
  for (const group of extra) root.groups.push(groupFile(group, ignored, pool));
  const meta = db.meta;
  const used = usedIcons(root, new Set());
  const customIcons = [...meta.customIcons].flatMap(([id, icon]) => {
    const uuid = hexOfUuid(new kdbxweb.KdbxUuid(id));
    return used.has(uuid)
      ? [
          {
            uuid,
            name: icon.name ?? "",
            data: new Uint8Array(icon.data).slice(),
          },
        ]
      : [];
  });
  return {
    header,
    meta: {
      name: meta.name ?? "",
      description: meta.desc ?? "",
      color: (meta.color ?? "") === "" ? null : (meta.color ?? null),
      publicColor: typeof publicColor === "string" ? publicColor : null,
      recycleBinEnabled: meta.recycleBinEnabled ?? true,
      recycleBinUuid: uuidOrNull(meta.recycleBinUuid),
      historyMaxItems: meta.historyMaxItems ?? null,
    },
    root,
    extraRoots: extra.length,
    ignored,
    binaries: pool.list,
    customIcons,
  };
}

export interface KdbxCredentialsInput {
  /** UTF-8 as typed, without NFC; `null` = no password. */
  password: Uint8Array | null;
  keyFile: Uint8Array | null;
}

/** Reads a KDBX file; `onHeader` runs before the key derivation. */
export async function readKdbx(
  data: ArrayBuffer,
  credentials: KdbxCredentialsInput,
  onHeader?: (header: KdbxHeaderInfo) => void,
): Promise<KdbxFile> {
  if (credentials.password === null && credentials.keyFile === null)
    throw new KdbxError("no_credentials");
  const header = inspectKdbxHeader(data);
  onHeader?.(header);
  try {
    const password =
      credentials.password === null
        ? null
        : kdbxweb.ProtectedValue.fromBinary(
            credentials.password.slice().buffer,
          );
    const keys = new kdbxweb.Credentials(password, credentials.keyFile);
    const db = await kdbxweb.Kdbx.load(data, keys);
    return fileOf(db, header);
  } catch (error) {
    throw kdbxErrorOf(error);
  }
}

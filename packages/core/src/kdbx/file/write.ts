/**
 * Writing KDBX 4.0 in the worker: AES-256, Argon2id with the
 * account defaults, GZip. kdbxweb draws fresh salts and IVs for every file.
 */
import * as kdbxweb from "kdbxweb";
import {
  KDBX_EXPORT_KDF,
  KdbxError,
  type KdbxExportEntryState,
  type KdbxExportGroup,
  type KdbxExportModel,
  type KdbxTimes,
} from "../types";
import { kdbxArgon2 } from "./argon2";
import { uuidOfHex } from "./uuid";

kdbxweb.CryptoEngine.setArgon2Impl(kdbxArgon2);

const { CipherId, CompressionAlgorithm, KdfId } = kdbxweb.Consts;
const { ValueType } = kdbxweb.VarDictionary;

function dateOf(iso: string | null, fallback: Date): Date {
  if (iso === null) return fallback;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : fallback;
}

function setTimes(target: kdbxweb.KdbxTimes, times: KdbxTimes): void {
  const now = new Date();
  const modified = dateOf(times.modified, now);
  target.creationTime = dateOf(times.created, modified);
  target.lastModTime = modified;
  target.lastAccessTime = modified;
  target.locationChanged = modified;
  target.expires = times.expires !== null;
  target.expiryTime = dateOf(times.expires, modified);
}

function fillEntry(
  entry: kdbxweb.KdbxEntry,
  source: KdbxExportEntryState,
  binaries: readonly kdbxweb.KdbxBinaryWithHash[],
): void {
  entry.uuid = uuidOfHex(source.uuid);
  entry.icon = source.icon;
  if (source.customIcon !== null)
    entry.customIcon = uuidOfHex(source.customIcon);
  entry.tags = [...source.tags];
  entry.fields = new Map(
    source.strings.map((field) => [
      field.key,
      field.protected
        ? kdbxweb.ProtectedValue.fromString(field.value)
        : field.value,
    ]),
  );
  setTimes(entry.times, source.times);
  entry.binaries = new Map();
  for (const attachment of source.attachments) {
    const binary = binaries[attachment.binary];
    if (binary !== undefined) entry.binaries.set(attachment.name, binary);
  }
}

function fillGroup(
  db: kdbxweb.Kdbx,
  group: kdbxweb.KdbxGroup,
  source: KdbxExportGroup,
  binaries: readonly kdbxweb.KdbxBinaryWithHash[],
): void {
  group.uuid = uuidOfHex(source.uuid);
  group.name = source.name;
  group.notes = source.notes;
  group.icon = source.icon;
  if (source.customIcon !== null)
    group.customIcon = uuidOfHex(source.customIcon);
  setTimes(group.times, source.times);
  for (const child of source.groups)
    fillGroup(db, db.createGroup(group, child.name), child, binaries);
  for (const item of source.entries) {
    const entry = db.createEntry(group);
    fillEntry(entry, item, binaries);
    entry.history = item.history.map((state) => {
      const snapshot = kdbxweb.KdbxEntry.create(db.meta, group);
      fillEntry(snapshot, state, binaries);
      return snapshot;
    });
  }
}

/** Writes the model; the password is NFC-normalised UTF-8. */
export async function writeKdbx(
  model: KdbxExportModel,
  password: Uint8Array,
): Promise<Uint8Array> {
  try {
    const credentials = new kdbxweb.Credentials(
      kdbxweb.ProtectedValue.fromBinary(password.slice().buffer),
    );
    const db = kdbxweb.Kdbx.create(credentials, model.meta.name);
    const header = db.header;
    db.setVersion(4);
    header.dataCipherUuid = new kdbxweb.KdbxUuid(CipherId.Aes);
    header.compression = CompressionAlgorithm.GZip;
    // save() draws the salt (S), master seed and IV.
    const params = new kdbxweb.VarDictionary();
    params.set(
      "$UUID",
      ValueType.Bytes,
      kdbxweb.ByteUtils.arrayToBuffer(
        kdbxweb.ByteUtils.base64ToBytes(KdfId.Argon2id),
      ),
    );
    params.set("P", ValueType.UInt32, KDBX_EXPORT_KDF.parallelism);
    params.set(
      "I",
      ValueType.UInt64,
      new kdbxweb.Int64(KDBX_EXPORT_KDF.iterations),
    );
    params.set(
      "M",
      ValueType.UInt64,
      new kdbxweb.Int64(KDBX_EXPORT_KDF.memoryBytes),
    );
    params.set("V", ValueType.UInt32, 0x13);
    header.kdfParameters = params;

    const meta = db.meta;
    meta.desc = model.meta.description;
    meta.color = model.meta.color ?? undefined;
    meta.historyMaxItems = model.meta.historyMaxItems;
    meta.recycleBinEnabled = model.meta.recycleBinEnabled;
    meta.recycleBinUuid =
      model.meta.recycleBinUuid === null
        ? new kdbxweb.KdbxUuid()
        : uuidOfHex(model.meta.recycleBinUuid);
    // Custom icons once; groups, entries and snapshots refer to them.
    for (const icon of model.customIcons)
      meta.customIcons.set(uuidOfHex(icon.uuid).id, {
        data: icon.data.slice().buffer,
      });

    // Kdbx.create adds a recycle bin of its own; the model brings its tree.
    const root = db.getDefaultGroup();
    root.groups = [];
    // Each attachment once; entries and snapshots refer to it.
    const binaries: kdbxweb.KdbxBinaryWithHash[] = [];
    for (const bytes of model.binaries)
      binaries.push(await db.createBinary(bytes.slice().buffer));
    fillGroup(db, root, model.root, binaries);
    meta.lastSelectedGroup = root.uuid;
    meta.lastTopVisibleGroup = root.uuid;
    return new Uint8Array(await db.save());
  } catch (error) {
    if (error instanceof KdbxError) throw error;
    throw new KdbxError("failed");
  }
}

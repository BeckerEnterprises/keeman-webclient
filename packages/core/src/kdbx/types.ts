/**
 * Plain KDBX models exchanged with the KDBX worker. They are
 * structured-clone friendly (no class instances) and contain secrets: they
 * never go into reactive state.
 */

export type KdbxErrorCode =
  | "not_kdbx"
  | "unsupported_version"
  | "unsupported_cipher"
  | "unsupported_kdf"
  | "kdf_limits"
  | "wrong_key"
  | "corrupt"
  | "too_large"
  | "no_credentials"
  | "cancelled"
  | "failed";

/** Carries only a code: library messages may quote file contents. */
export class KdbxError extends Error {
  constructor(readonly code: KdbxErrorCode) {
    super(`KDBX error: ${code}`);
    this.name = "KdbxError";
  }
}

export const KDBX_LIMITS = {
  /** Largest input file. */
  fileBytes: 128 * 1024 * 1024,
  /** Largest Argon2 memory of an input file. */
  argon2MemoryBytes: 1024 * 1024 * 1024,
  /** Above this, the dialog says opening may take long. */
  argon2HintBytes: 256 * 1024 * 1024,
} as const;

/** Export parameters: Argon2id like the account default. */
export const KDBX_EXPORT_KDF = {
  memoryBytes: 64 * 1024 * 1024,
  iterations: 3,
  parallelism: 1,
} as const;

export interface KdbxHeaderInfo {
  /** `major.minor`, e.g. `4.1`. */
  version: string;
  cipher: "aes" | "chacha20";
  kdf: "argon2d" | "argon2id" | "aes";
  /** Argon2 only. */
  memoryBytes: number | null;
}

export interface KdbxString {
  key: string;
  value: string;
  protected: boolean;
}

/** ISO 8601 timestamps; `null` when missing or not representable. */
export interface KdbxTimes {
  created: string | null;
  modified: string | null;
  /** Only when the file says `Expires = True`. */
  expires: string | null;
}

/** Things the import does not take over, counted per object. */
export type KdbxIgnoredKind =
  | "autoType"
  | "customData"
  | "colors"
  | "overrideUrl"
  | "qualityCheck"
  | "groupSettings"
  | "deletedObjects"
  | "publicCustomData";

/** An attachment of an entry state: its name and a binary of the pool. */
export interface KdbxAttachmentRef {
  name: string;
  /** Index into `binaries` of the file or model. */
  binary: number;
}

export interface KdbxEntryState {
  /** 32 lowercase hex digits; all zeros for a null UUID. */
  uuid: string;
  /** KeePass standard icon index, if any. */
  icon: number | null;
  /** UUID of a custom icon (32 lowercase hex digits), if any. */
  customIcon: string | null;
  /** In file order, standard strings included. */
  strings: KdbxString[];
  tags: string[];
  times: KdbxTimes;
  attachments: KdbxAttachmentRef[];
  previousParent: string | null;
}

export interface KdbxEntryFile extends KdbxEntryState {
  /** Oldest first, as in the file. */
  history: KdbxEntryState[];
}

export interface KdbxGroupFile {
  uuid: string;
  name: string;
  notes: string;
  icon: number | null;
  customIcon: string | null;
  times: KdbxTimes;
  previousParent: string | null;
  groups: KdbxGroupFile[];
  entries: KdbxEntryFile[];
}

export interface KdbxMetaFile {
  name: string;
  description: string;
  color: string | null;
  /** `KPXC_PUBLIC_COLOR` of the public header data. */
  publicColor: string | null;
  recycleBinEnabled: boolean;
  recycleBinUuid: string | null;
  historyMaxItems: number | null;
}

/** A decrypted KDBX file, as read in the worker. */
export interface KdbxFile {
  header: KdbxHeaderInfo;
  meta: KdbxMetaFile;
  root: KdbxGroupFile;
  /** Further top-level groups were moved under the root. */
  extraRoots: number;
  ignored: Record<KdbxIgnoredKind, number>;
  /** The file's binaries, each content once. */
  binaries: Uint8Array[];
  /** Custom icons that groups, entries or snapshots use. */
  customIcons: KdbxCustomIcon[];
}

/** A custom icon of a file: the bytes as stored, usually PNG. */
export interface KdbxCustomIcon {
  /** 32 lowercase hex digits. */
  uuid: string;
  /** KDBX 4.1 only; otherwise empty. */
  name: string;
  data: Uint8Array;
}

export interface KdbxExportEntryState {
  uuid: string;
  icon: number;
  /** UUID of an icon in `customIcons`, if any. */
  customIcon: string | null;
  strings: KdbxString[];
  tags: string[];
  times: KdbxTimes;
  attachments: KdbxAttachmentRef[];
}

export interface KdbxExportEntry extends KdbxExportEntryState {
  /** Oldest first. */
  history: KdbxExportEntryState[];
}

export interface KdbxExportGroup {
  uuid: string;
  name: string;
  notes: string;
  icon: number;
  customIcon: string | null;
  times: KdbxTimes;
  groups: KdbxExportGroup[];
  entries: KdbxExportEntry[];
}

/** What the worker writes as KDBX 4.0. */
export interface KdbxExportModel {
  meta: {
    name: string;
    description: string;
    color: string | null;
    historyMaxItems: number;
    recycleBinEnabled: boolean;
    recycleBinUuid: string | null;
  };
  root: KdbxExportGroup;
  /** Decrypted attachments, each once. */
  binaries: Uint8Array[];
  /** Custom icons as PNG, each once. */
  customIcons: { uuid: string; data: Uint8Array }[];
}

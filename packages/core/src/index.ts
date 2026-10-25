/**
 * KeeMan client core. Runs in browsers, web workers and Node; uses neither Vue
 * nor DOM APIs. The public surface is the account facade with its API client;
 * the crypto building blocks stay internal. The Argon2 worker protocol
 * is exported separately as `@keeman/core/argon2-worker`.
 */
export type { components, operations, paths } from "./api/openapi.gen";
export {
  ApiClient,
  type AccessToken,
  type ApiClientOptions,
  type LoginOutcome,
  type RefreshCoordinator,
} from "./api/client";
export {
  ApiError,
  NetworkError,
  type ApiErrorDetails,
  type NetworkErrorReason,
  type ProblemCode,
} from "./api/errors";
export type {
  PasskeyInfo,
  SecondFactorMethod,
  ServerConfig,
  SessionInfo,
} from "./api/schemas";
export {
  Account,
  type AccountOptions,
  type LoginResult,
  type PasskeyRegistration,
  type PendingRegistration,
  type RecoveryKeyRenewal,
  type RecoveryProcess,
  type RecoveryStage,
  type RecoveryStep,
  type RegistrationInput,
  type SecondFactorLogin,
  type TotpSetup,
  type TwoFactorStatus,
  type UnlockReport,
} from "./account/account";
export { AccountError, type AccountErrorCode } from "./account/errors";
export type { KdfCost, KdfMemory } from "./account/kdf-memory";
export { matchesRecoveryKeyGroup } from "./account/recovery-key";
export {
  DEFAULT_KDF_PARAMS,
  KDF_LIMITS,
  type KdfParams,
} from "./crypto/argon2";
export { CryptoError, type CryptoErrorCode } from "./crypto/errors";
export { initCrypto } from "./crypto/sodium";
export type { CorruptReason, IconRef } from "./model/vault";
export {
  emptyDraft,
  MAX_ATTACHMENTS,
  validateEntryDraft,
  type AttachmentInfo,
  type CustomField,
  type DraftProblem,
  type EntryDraft,
} from "./model/entry";
export { BUILTIN_ICONS, DEFAULT_ICONS } from "./model/icons";
export {
  faviconIconName,
  faviconTarget,
  ICON_SIZE,
  uploadIconName,
  type IconSource,
} from "./model/icon";
export {
  readKdbxInWorker,
  writeKdbxInWorker,
  type KdbxReadInput,
  type KdbxWorkerOptions,
} from "./kdbx/client";
export {
  kdbxFileName,
  verifyKdbxExport,
  type KdbxExportItem,
  type KdbxExportReport,
} from "./kdbx/export";
export type { KdbxImportReport, KdbxPath, KdbxReportItem } from "./kdbx/plan";
export {
  KDBX_LIMITS,
  KdbxError,
  type KdbxErrorCode,
  type KdbxExportModel,
  type KdbxFile,
  type KdbxHeaderInfo,
} from "./kdbx/types";
export {
  GENERATOR_DEFAULTS,
  GENERATOR_LIMITS,
  generateSecret,
  secretBits,
  type GeneratorOptions,
} from "./generator/index";
export {
  checkScheme,
  FORBIDDEN_SCHEMES,
  type PlaceholderWarning,
  type ResolvedText,
  type ResolvedUrl,
  type SchemeProblem,
  type UrlError,
} from "./placeholders/resolve";
export type { SearchQuery, SearchScope } from "./search/index";
export { totpFromUri, type TotpCode, type TotpResult } from "./totp/code";
export { CLOCK_SKEW_HINT_MS } from "./totp/clock";
export {
  buildTotpUri,
  decodeTotpSecret,
  parseOtpUri,
  TOTP_DEFAULTS,
  TOTP_LIMITS,
  type OtpParse,
  type OtpProblem,
  type TotpAlgorithm,
  type TotpParams,
} from "./totp/uri";
export type {
  CorruptObjectView,
  DeletePlan,
  InvitationView,
  EntryBase,
  EntryDetail,
  EntrySummary,
  EntryValues,
  GroupProps,
  HistoryItem,
  IconView,
  ItemRef,
  KdbxImportJob,
  KdbxImportProgress,
  KdbxImportRun,
  KdbxImportTarget,
  MoveBlock,
  MoveCheck,
  MoveTarget,
  NewVaultNames,
  Notice,
  ResolvedValues,
  SyncEngine,
  SyncEngineOptions,
  SyncSnapshot,
  TreeNode,
  TreeNodeProblem,
  VaultChange,
  VaultTree,
  VaultView,
  WriteResult,
} from "./sync/engine";
export type {
  AttachmentFile,
  AttachmentProgress,
  AttachmentRun,
} from "./sync/attachments";
export { SyncError, type SyncErrorCode } from "./sync/errors";
export type { Candidate } from "./sharing/candidate";
export type { ContactStatus, ContactView } from "./sharing/contacts";
export type { MemberView } from "./sharing/members";
export type {
  CorruptObject,
  RotationDecisions,
  RotationRecipient,
  RotationReview,
} from "./sharing/rotation";
export type { ConnectionState, SocketFactory, SocketLike } from "./sync/events";
export {
  storedSyncMarks,
  type MarksLock,
  type MarksStore,
  type SyncMarks,
} from "./sync/marks";
export {
  isUrlSchemeList,
  LANGUAGES,
  SETTING_DEFAULTS,
  type Language,
  type Settings,
  type SettingsChange,
  type UserDataState,
} from "./model/user-data";

/** Major version of the KeeMan API this core speaks. */
export const API_VERSION = 1;

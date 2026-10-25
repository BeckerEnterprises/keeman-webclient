export type SyncErrorCode =
  /** No answer after the automatic retries; `retry()` sends the same bytes again. */
  | "network"
  /** Three attempts to merge after conflicts failed. */
  | "conflict_unresolved"
  /** The vault or object may not be written: corrupt, rolled back, newer schema or no owner. */
  | "read_only"
  /** The vault key changed (rotation); reload first. */
  | "stale_key"
  /** The vault is gone. */
  | "not_found"
  /** The name is empty or too long. */
  | "invalid_name"
  /** The target is missing, the group itself or below it, or not allowed. */
  | "invalid_target"
  /** The entry draft breaks a save rule. */
  | "invalid_entry"
  /** The object would exceed its size limit. */
  | "too_large"
  /** Copied to the other vault, but the originals could not be deleted. */
  | "move_incomplete"
  /** The master password is wrong (local check). */
  | "wrong_password"
  /** The file is larger than `attachment_max_bytes`. */
  | "attachment_too_large"
  /** The blob does not decrypt or has the wrong length. */
  | "attachment_corrupt"
  /** The attachment is not in the entry or not on the server. */
  | "attachment_missing"
  /** The caller aborted, e.g. an upload. */
  | "cancelled"
  /** The account is not a verified contact. */
  | "unverified"
  /** The own account cannot be invited. */
  | "self"
  /** An invitation or pending key fails the checks of its key box. */
  | "key_box_invalid"
  /** The vault or its members changed during a rotation; review again. */
  | "rotation_conflict"
  /** Corrupt objects block the rotation until the owner drops them, and the icon cleanup. */
  | "corrupt_objects"
  /** Not a 64 × 64 PNG of at most 32 KiB. */
  | "invalid_icon"
  /** Not an http or https address. */
  | "invalid_url"
  /** A rollback warning is open; acknowledge it first. */
  | "rollback_open"
  | "locked";

export class SyncError extends Error {
  override readonly name = "SyncError";
  readonly code: SyncErrorCode;
  /** For `network`: sends the same request again. */
  readonly retry: (() => Promise<unknown>) | undefined;

  constructor(code: SyncErrorCode, retry?: () => Promise<unknown>) {
    super(`Sync error ${code}`);
    this.code = code;
    this.retry = retry;
  }
}

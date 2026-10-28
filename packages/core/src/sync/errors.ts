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
  /** The account has no signing key yet, so it cannot be verified. */
  | "unverifiable"
  /** The sender of a pending key is not a known owner; confirm first. */
  | "unknown_owner"
  /** The roles chain is missing, rolled back or contradictory; nothing is signed or accepted. */
  | "roles_invalid"
  /** The vault's new owner list has not been taken over yet; confirm first. */
  | "roles_unconfirmed"
  /** The roles chain does not commit to the boxed key. */
  | "roles_rejected"
  /** Co-owners must be verified before the owner list can be signed. */
  | "owners_unverified"
  /** The own account cannot be invited. */
  | "self"
  /** An invitation or pending key fails the checks of its key box. */
  | "key_box_invalid"
  /** The vault or its members changed during a rotation; review again. */
  | "rotation_conflict"
  /** An owner is renewing the vault's key and removes this account meanwhile. */
  | "rotation_in_progress"
  /** Corrupt objects block the rotation until the owner drops them, and the icon cleanup. */
  | "corrupt_objects"
  /** Not a 64 × 64 PNG of at most 32 KiB. */
  | "invalid_icon"
  /** Not an http or https address. */
  | "invalid_url"
  /** A rollback warning is open; acknowledge it first. */
  | "rollback_open"
  /** The delivered state does not match the vault manifest; acknowledge first. */
  | "manifest_mismatch"
  /** No device of the account confirmed the vault within the period; pair or confirm first. */
  | "stale"
  /** The server offers no confirmation by another device. */
  | "confirmation_unsupported"
  /** The answer does not verify: forged, for another request or account. */
  | "confirmation_invalid"
  /** The request is no longer open (expired, declined or withheld). */
  | "confirmation_missing"
  /** Another device answered the request first. */
  | "confirmation_answered"
  /** The own request ran out without an answer. */
  | "confirmation_expired"
  /** This device knows more than fits into one answer. */
  | "confirmation_too_large"
  /** The state code has invalid characters, length or form. */
  | "state_code_invalid"
  /** A member's state code contradicts the chain; acknowledge first. */
  | "state_mismatch"
  /** The owner list changed since it was shown; look again. */
  | "roles_changed"
  /** An invitation's owner list contradicts what the account knew before; accept explicitly. */
  | "former_conflict"
  /** The sender of the invitation owns no part of the list its box names. */
  | "sender_not_owner"
  /** A warning about the owner list is open; nothing is signed until understood. */
  | "roles_warning_open"
  /** The server names an owner list this device cannot load or check yet; try again. */
  | "roles_unavailable"
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

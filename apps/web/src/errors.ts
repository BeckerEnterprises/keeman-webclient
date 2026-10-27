/**
 * Maps errors to translated messages: a message per code, the
 * correlation ID as "error ID", never server `detail` texts or exception
 * messages.
 */
import {
  AccountError,
  ApiError,
  CryptoError,
  KdbxError,
  NetworkError,
  SyncError,
} from "@keeman/core";
import { ConfigError } from "./config";
import { IconImageError } from "./icon-image";
import { WebauthnError } from "./webauthn";

export interface UiError {
  /** i18n key below `error.` */
  key: string;
  instance?: string;
  /** Seconds to wait (429). */
  retryAfter?: number;
}

const API_CODES = new Set([
  "invalid_credentials",
  "session_invalid",
  "reauth_required",
  "forbidden",
  "registration_closed",
  "invite_invalid",
  "account_disabled",
  "email_taken",
  "already_registered",
  "kdf_params_invalid",
  "conflict",
  "validation_failed",
  "not_found",
  "request_timeout",
  "payload_too_large",
  "internal_error",
  "sole_owner_of_shared_vault",
  "stale_key_version",
  "idempotency_key_reused",
  "attachment_too_large",
  "attachment_incomplete",
  "already_member",
  "user_not_found",
  "last_owner",
  "key_version_mismatch",
  "use_rotate",
  "rotation_invalid",
  "rotation_incomplete",
  "invalid_second_factor",
  "challenge_invalid",
  "two_factor_state_invalid",
  "url_not_allowed",
  "favicon_not_found",
  "feature_disabled",
  "roles_conflict",
  "owner_must_demote",
  "signing_key_missing",
  "roles_required",
]);

export function toUiError(error: unknown): UiError {
  if (error instanceof ApiError) {
    const instance = error.details.instance?.replace(/^urn:uuid:/, "");
    if (error.status === 429)
      return {
        key: "rate_limited",
        instance,
        retryAfter: error.details.retryAfter ?? 60,
      };
    // 507: the storage quota of the vault's owner; final, never retried.
    if (error.code === "quota_exceeded")
      return { key: "quota_exceeded", instance };
    if (error.status >= 500) return { key: "server", instance };
    return {
      key: API_CODES.has(error.code) ? error.code : "unexpected",
      instance,
    };
  }
  if (error instanceof NetworkError)
    return { key: error.reason === "response" ? "bad_response" : "network" };
  if (error instanceof AccountError)
    return {
      key: error.possiblyManipulated
        ? "wrong_password_manipulated"
        : error.code,
    };
  if (error instanceof SyncError) return { key: `sync_${error.code}` };
  if (error instanceof KdbxError) return { key: `kdbx_${error.code}` };
  if (error instanceof CryptoError)
    return {
      key: error.code === "validation" ? "password_malformed" : "crypto",
    };
  if (error instanceof ConfigError) return { key: "config" };
  if (error instanceof IconImageError) return { key: `icon_${error.reason}` };
  if (error instanceof WebauthnError)
    return { key: `webauthn_${error.reason}` };
  return { key: "unexpected" };
}

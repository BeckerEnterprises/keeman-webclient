import type { components } from "./openapi.gen";

export type ProblemCode = components["schemas"]["ProblemCode"];

const PROBLEM_CODES: ReadonlySet<string> = new Set<ProblemCode>([
  "validation_failed",
  "url_not_allowed",
  "invalid_credentials",
  "invalid_second_factor",
  "challenge_invalid",
  "session_invalid",
  "reauth_required",
  "forbidden",
  "registration_closed",
  "invite_invalid",
  "account_disabled",
  "not_found",
  "user_not_found",
  "feature_disabled",
  "method_not_allowed",
  "request_timeout",
  "conflict",
  "refresh_superseded",
  "rotation_invalid",
  "stale_key_version",
  "key_version_mismatch",
  "email_taken",
  "already_registered",
  "already_member",
  "last_owner",
  "sole_owner_of_shared_vault",
  "use_rotate",
  "two_factor_state_invalid",
  "resync_required",
  "payload_too_large",
  "attachment_too_large",
  "unsupported_media_type",
  "range_not_satisfiable",
  "kdf_params_invalid",
  "rotation_incomplete",
  "favicon_not_found",
  "idempotency_key_reused",
  "attachment_incomplete",
  "manifest_required",
  "rate_limited",
  "internal_error",
  "quota_exceeded",
]);

export function isProblemCode(value: unknown): value is ProblemCode {
  return typeof value === "string" && PROBLEM_CODES.has(value);
}

/** One entry of `conflicts` of a batch. */
export interface BatchConflict {
  id: string;
  /** `null`: the object does not exist. */
  currentRevision: number | null;
  deleted: boolean;
}

export interface ApiErrorDetails {
  /** Correlation ID (`instance`), shown to users as "error ID". */
  instance?: string;
  /** Seconds from `Retry-After` (429). */
  retryAfter?: number;
  /** `current_revision` of `409 conflict`. */
  currentRevision?: number;
  /** `current_key_version` of `stale_key_version` and `key_version_mismatch`. */
  currentKeyVersion?: number;
  /** `conflicts` of a batch conflict. */
  conflicts?: BatchConflict[];
}

/**
 * The server answered with an error. Only the code and fixed
 * fields are kept; `detail` texts are never shown.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  /** `unknown` for codes this client does not know. */
  readonly code: ProblemCode | "unknown";
  readonly details: ApiErrorDetails;

  constructor(
    status: number,
    code: ProblemCode | "unknown",
    details: ApiErrorDetails = {},
  ) {
    super(`API error ${String(status)} ${code}`);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type NetworkErrorReason = "network" | "timeout" | "response";

/**
 * No usable answer: the request failed, timed out, or the response did not
 * match the API contract.
 */
export class NetworkError extends Error {
  override readonly name = "NetworkError";
  readonly reason: NetworkErrorReason;

  constructor(reason: NetworkErrorReason) {
    super(`Network error (${reason})`);
    this.reason = reason;
  }
}

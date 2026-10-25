export type AccountErrorCode =
  /** The master password does not open the user key. */
  | "wrong_password"
  /** The second-factor step or the recovery ran out of time. */
  | "challenge_expired"
  /** The typed recovery key fails the local check. */
  | "recovery_key_malformed"
  /** The server delivered data that does not fit together. */
  | "integrity"
  /** KDF parameters outside the allowed range. */
  | "kdf_invalid"
  | "user_data_corrupt"
  | "user_data_read_only"
  /** Three attempts to merge user_data failed. */
  | "conflict_unresolved"
  /** The reauth token expired; ask for the password again. */
  | "reauth_required"
  | "locked";

export class AccountError extends Error {
  override readonly name = "AccountError";
  readonly code: AccountErrorCode;
  /**
   * `wrong_password` while the server offers weaker KDF parameters than seen
   * before: the parameters may have been manipulated.
   */
  readonly possiblyManipulated: boolean;

  constructor(code: AccountErrorCode, possiblyManipulated = false) {
    super(`Account error ${code}`);
    this.code = code;
    this.possiblyManipulated = possiblyManipulated;
  }
}

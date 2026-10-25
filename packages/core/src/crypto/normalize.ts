import { utf8Encode } from "./bytes";
import { CryptoError } from "./errors";

/** Master password: reject ill-formed Unicode, then NFC and UTF-8, no trimming. */
export function normalizePassword(password: string): Uint8Array {
  if (!password.isWellFormed())
    throw new CryptoError("validation", "Password is not well-formed Unicode");
  return utf8Encode(password.normalize("NFC"));
}

const OUTER_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** E-mail: trim Unicode White_Space, NFC, lowercase without locale. */
export function normalizeEmail(email: string): string {
  return email.replace(OUTER_WHITE_SPACE, "").normalize("NFC").toLowerCase();
}

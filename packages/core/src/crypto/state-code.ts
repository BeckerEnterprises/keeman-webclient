// The state code of a vault: a short code of the checked head of its roles
// chain that two members compare over a second channel. Because statements
// are linked through their hashes, a server can never merge views it kept
// apart without being noticed, so one comparison detects a fork later.
import { fromBase32, toBase32 } from "./base32";
import { concatBytes, fromBase64Url, utf8Encode } from "./bytes";
import { CryptoError } from "./errors";
import { sodium } from "./sodium";

export const STATE_CODE_BYTES = 16;
const CODE_CHARS = 26;
const URI_PREFIX = "keeman:state:";
const SPACE = "[ \\t\\n\\r\\u00a0]";
const TRIM = new RegExp(`^${SPACE}+|${SPACE}+$`, "g");
const URI = new RegExp(
  "^keeman:state:" +
    "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})" +
    ":([1-9][0-9]*):([A-Z2-7]{26})$",
);
// The separator between version and code is required: Base32 contains the
// digits 2 to 7, so "v72..." could be version 7 or 72.
const TEXT = /^[vV]?([1-9][0-9]*)[ \t\n\r\u00a0\u00b7:-]+([^]*)$/;
const IGNORED = /[ \t\n\r\u00a0-]/g;

/** A version of the roles chain with the code of its statement. */
export interface StateCode {
  readonly version: number;
  /** 26 characters of Base32. */
  readonly code: string;
}

/** What a user entered; the vault comes only with the QR form. */
export interface EnteredStateCode extends StateCode {
  readonly vaultId: string | null;
}

/** A checked statement, as far as the state code needs it. */
export interface ChainPoint {
  readonly statement: { readonly version: number };
  /** h(S) as Base64url. */
  readonly hash: string;
}

/** BLAKE2b with output length 16 of "keeman:v1:state-code" ‖ 0x00 ‖ h(S). */
export function stateCodeOf(hash: string): string {
  const raw = fromBase64Url(hash, 32);
  return toBase32(
    sodium().crypto_generichash(
      STATE_CODE_BYTES,
      concatBytes(utf8Encode("keeman:v1:state-code"), Uint8Array.of(0x00), raw),
      null,
    ),
  );
}

export function headCode(point: ChainPoint): StateCode {
  return { version: point.statement.version, code: stateCodeOf(point.hash) };
}

/** "v7 · XXXX XXXX XXXX XXXX XXXX XXXX XX". */
export function formatStateCode(c: StateCode): string {
  return `v${String(c.version)} · ${c.code.match(/.{1,4}/g)?.join(" ") ?? ""}`;
}

/** The content of the QR code: it names the vault as well. */
export function stateCodeUri(vaultId: string, c: StateCode): string {
  return `${URI_PREFIX}${vaultId}:${String(c.version)}:${c.code}`;
}

function invalid(): never {
  throw new CryptoError("validation", "Invalid state code");
}

function version(digits: string): number {
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) invalid();
  return value;
}

function canonical(code: string): string {
  if (!/^[A-Z2-7]*$/.test(code) || code.length !== CODE_CHARS) invalid();
  try {
    fromBase32(code);
  } catch {
    invalid();
  }
  return code;
}

/**
 * Reads the QR form or text: an optional "v", the version, at least one
 * separator, and the code, in which spaces and hyphens are ignored and
 * a–z count as A–Z.
 */
export function parseStateCode(input: string): EnteredStateCode {
  const text = input.replace(TRIM, "");
  if (text.startsWith(URI_PREFIX)) {
    const match = URI.exec(text);
    if (!match) invalid();
    const [, vaultId = "", digits = "", code = ""] = match;
    return { version: version(digits), code: canonical(code), vaultId };
  }
  const match = TEXT.exec(text);
  if (!match) invalid();
  const [, digits = "", rest = ""] = match;
  const code = rest
    .replace(IGNORED, "")
    .replace(/[a-z]/g, (c) => c.toUpperCase());
  return { version: version(digits), code: canonical(code), vaultId: null };
}

export type StateComparison =
  | { readonly result: "match" }
  /** The other side is behind; `own` is this device's head to check. */
  | { readonly result: "behind"; readonly own: StateCode }
  /** `own` is this device's code of the same version. */
  | { readonly result: "mismatch"; readonly own: StateCode }
  /** The chain does not contain the version, though it lies below the head. */
  | { readonly result: "withheld" }
  /** The version lies above the head. */
  | { readonly result: "ahead" }
  | { readonly result: "other_vault" };

/**
 * Compares an entered code with the statement of the same version of a
 * checked chain (ascending). Other versions never count, or a forger would
 * have many targets at once.
 */
export function compareStateCode(input: {
  vaultId: string;
  statements: readonly ChainPoint[];
  entered: EnteredStateCode;
}): StateComparison {
  const { entered, statements } = input;
  if (entered.vaultId !== null && entered.vaultId !== input.vaultId)
    return { result: "other_vault" };
  const head = statements[statements.length - 1];
  if (!head || entered.version > head.statement.version)
    return { result: "ahead" };
  const at = statements.find((s) => s.statement.version === entered.version);
  if (!at) return { result: "withheld" };
  const own = headCode(at);
  if (own.code !== entered.code) return { result: "mismatch", own };
  if (at === head) return { result: "match" };
  return { result: "behind", own: headCode(head) };
}

export type PointsStatus =
  | { readonly status: "ok" }
  | { readonly status: "fork" | "rollback"; readonly point: StateCode };

/** Whether the checked chain has the statement of the point with its code. */
export function satisfies(
  statements: readonly ChainPoint[],
  point: StateCode,
): boolean {
  return statements.some(
    (s) =>
      s.statement.version === point.version &&
      stateCodeOf(s.hash) === point.code,
  );
}

/**
 * Comparison points only restrict: one above the head is a rollback, any
 * other one the chain does not satisfy a fork. A fork comes first, then the
 * lowest version.
 */
export function comparisonPointsStatus(
  statements: readonly ChainPoint[],
  points: readonly StateCode[],
): PointsStatus {
  const top = statements[statements.length - 1]?.statement.version ?? 0;
  let fork: StateCode | undefined;
  let rollback: StateCode | undefined;
  for (const point of [...points].sort((a, b) => a.version - b.version)) {
    if (satisfies(statements, point)) continue;
    if (point.version > top) rollback ??= point;
    else fork ??= point;
  }
  if (fork) return { status: "fork", point: fork };
  if (rollback) return { status: "rollback", point: rollback };
  return { status: "ok" };
}

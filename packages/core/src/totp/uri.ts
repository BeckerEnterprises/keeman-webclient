/**
 * otpauth key URIs: parsing, normalising and building, for the editor and
 * the KDBX import.
 */
import { toBase32 } from "../crypto/base32";

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export const TOTP_DEFAULTS = {
  algorithm: "SHA1" as TotpAlgorithm,
  digits: 6,
  period: 30,
} as const;

export const TOTP_LIMITS = {
  digits: { min: 6, max: 8 },
  period: { min: 15, max: 300 },
} as const;

export interface TotpParams {
  /** Normalised Base32: uppercase, without spaces. */
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

/** Why a value is not a usable TOTP URI; never contains the value. */
export type OtpProblem =
  | "not_otpauth"
  | "hotp"
  | "steam"
  | "secret"
  | "algorithm"
  | "digits"
  | "period";

export type OtpParse =
  | { ok: true; params: TotpParams; normalized: string }
  | { ok: false; problem: OtpProblem };

const URI = /^otpauth:\/\/([^/?#]*)\/([^?#]*)(?:\?([^#]*))?(#.*)?$/i;
const BASE32 = /^[A-Z2-7]+$/;
const DECIMAL = /^[0-9]{1,4}$/;

/**
 * Base32 as the key URI format allows it: spaces removed, any case, padding
 * optional. Fill bits are not checked (authenticator apps do not either).
 */
export function normalizeTotpSecret(raw: string): string | null {
  let text = raw.replace(/\s+/g, "").toUpperCase();
  const padded = /=+$/.exec(text);
  if (padded !== null) {
    if (text.length % 8 !== 0) return null;
    text = text.slice(0, padded.index);
  }
  if (!BASE32.test(text) || ![0, 2, 4, 5, 7].includes(text.length % 8))
    return null;
  return text;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The key bytes of a secret as the key URI format allows it; fill bits are dropped. */
export function decodeTotpSecret(raw: string): Uint8Array | null {
  const secret = normalizeTotpSecret(raw);
  if (secret === null) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of secret) {
    buffer = (buffer << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
    buffer &= (1 << bits) - 1;
  }
  return out.length > 0 ? Uint8Array.from(out) : null;
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return null;
  }
}

function algorithmOf(raw: string | undefined): TotpAlgorithm | null {
  if (raw === undefined) return TOTP_DEFAULTS.algorithm;
  const upper = raw.toUpperCase().replace("-", "");
  return upper === "SHA1" || upper === "SHA256" || upper === "SHA512"
    ? upper
    : null;
}

function numberIn(
  raw: string | undefined,
  fallback: number,
  limits: { min: number; max: number },
): number | null {
  if (raw === undefined) return fallback;
  if (!DECIMAL.test(raw)) return null;
  const value = Number(raw);
  return value >= limits.min && value <= limits.max ? value : null;
}

/**
 * Parses an otpauth URI. Only TOTP is supported in v1: HOTP and Steam
 * report their own problem, so callers can keep the value unchanged.
 * `normalized` is the URI with only the secret rewritten; every other part
 * stays byte for byte.
 */
export function parseOtpUri(uri: string): OtpParse {
  const match = URI.exec(uri.trim());
  if (match === null) return { ok: false, problem: "not_otpauth" };
  const [, type = "", label = "", query = "", fragment = ""] = match;
  const kind = type.toLowerCase();
  if (kind === "hotp") return { ok: false, problem: "hotp" };
  if (kind !== "totp") return { ok: false, problem: "not_otpauth" };

  const params = new Map<string, string>();
  const parts = query === "" ? [] : query.split("&");
  let secretIndex = -1;
  for (const [index, part] of parts.entries()) {
    const equals = part.indexOf("=");
    const key = (equals < 0 ? part : part.slice(0, equals)).toLowerCase();
    if (params.has(key)) continue;
    const value = decoded(equals < 0 ? "" : part.slice(equals + 1));
    if (value === null) {
      if (key === "secret") return { ok: false, problem: "secret" };
      continue;
    }
    params.set(key, value);
    if (key === "secret") secretIndex = index;
  }
  if (params.get("encoder")?.toLowerCase() === "steam")
    return { ok: false, problem: "steam" };
  const secret = normalizeTotpSecret(params.get("secret") ?? "");
  if (secret === null || secretIndex < 0)
    return { ok: false, problem: "secret" };
  const algorithm = algorithmOf(params.get("algorithm"));
  if (algorithm === null) return { ok: false, problem: "algorithm" };
  const digits = numberIn(
    params.get("digits"),
    TOTP_DEFAULTS.digits,
    TOTP_LIMITS.digits,
  );
  if (digits === null) return { ok: false, problem: "digits" };
  const period = numberIn(
    params.get("period"),
    TOTP_DEFAULTS.period,
    TOTP_LIMITS.period,
  );
  if (period === null) return { ok: false, problem: "period" };

  parts[secretIndex] = `secret=${secret}`;
  const normalized = `otpauth://${type}/${label}?${parts.join("&")}${fragment}`;
  return {
    ok: true,
    params: { secret, algorithm, digits, period },
    normalized,
  };
}

export interface TotpUriInput {
  /** Raw secret bytes; encoded as Base32. */
  key: Uint8Array;
  algorithm?: TotpAlgorithm;
  digits?: number;
  period?: number;
  /** Entry title: label prefix and issuer. */
  title: string;
  username: string;
}

/**
 * Builds `otpauth://totp/<title>:<username>?secret=…&issuer=<title>&…`.
 * Empty label parts and default parameters are left out.
 */
export function buildTotpUri(input: TotpUriInput): string {
  const digits = input.digits ?? TOTP_DEFAULTS.digits;
  const period = input.period ?? TOTP_DEFAULTS.period;
  if (
    input.key.length === 0 ||
    numberIn(String(digits), digits, TOTP_LIMITS.digits) === null ||
    numberIn(String(period), period, TOTP_LIMITS.period) === null
  )
    throw new RangeError("TOTP parameters out of range");
  const label = [input.title, input.username]
    .filter((part) => part !== "")
    .map(encodeURIComponent)
    .join(":");
  const query = [`secret=${toBase32(input.key)}`];
  if (input.title !== "")
    query.push(`issuer=${encodeURIComponent(input.title)}`);
  const algorithm = input.algorithm ?? TOTP_DEFAULTS.algorithm;
  if (algorithm !== TOTP_DEFAULTS.algorithm)
    query.push(`algorithm=${algorithm}`);
  if (digits !== TOTP_DEFAULTS.digits) query.push(`digits=${String(digits)}`);
  if (period !== TOTP_DEFAULTS.period) query.push(`period=${String(period)}`);
  return `otpauth://totp/${label}?${query.join("&")}`;
}

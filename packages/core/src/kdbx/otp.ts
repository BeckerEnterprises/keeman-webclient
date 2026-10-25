/**
 * OTP strings of KDBX entries become one `otp` URI: a KeePassXC
 * `otp` URI first, else KeePass 2 `TimeOtp-*`, `TOTP Seed`/`TOTP Settings`
 * or KeeOtp. Strings that cannot be converted stay as fields.
 */
import {
  buildTotpUri,
  decodeTotpSecret,
  parseOtpUri,
  TOTP_DEFAULTS,
  TOTP_LIMITS,
  type OtpProblem,
  type TotpAlgorithm,
} from "../totp/uri";
import type { KdbxString } from "./types";

const TIME_OTP_SECRETS: readonly [
  string,
  (text: string) => Uint8Array | null,
][] = [
  ["TimeOtp-Secret", (text) => new TextEncoder().encode(text)],
  ["TimeOtp-Secret-Hex", hexBytes],
  ["TimeOtp-Secret-Base32", decodeTotpSecret],
  ["TimeOtp-Secret-Base64", base64Bytes],
];
const TIME_OTP_KEYS = [
  ...TIME_OTP_SECRETS.map(([key]) => key),
  "TimeOtp-Length",
  "TimeOtp-Period",
  "TimeOtp-Algorithm",
];
const SEED_KEYS = ["TOTP Seed", "TOTP Settings"];

interface Totp {
  key: Uint8Array;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
}

interface Candidate {
  keys: string[];
  /** Converted parameters; `undefined` when the strings cannot be used. */
  totp?: Totp;
  /** A normalised otpauth URI from the file itself. */
  uri?: string;
  /** Why an otpauth URI cannot be used. */
  problem?: OtpProblem;
}

export interface OtpConversion {
  otp: string | null;
  /** Keys that do not become fields. */
  consumed: Set<string>;
  /** `otp` kept unchanged because v1 cannot use it. */
  kept?: OtpProblem;
  /** OTP strings left as fields. */
  unconverted: string[];
}

function hexBytes(text: string): Uint8Array | null {
  const hex = text.replace(/\s+/g, "");
  if (!/^(?:[0-9A-Fa-f]{2})+$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

function base64Bytes(text: string): Uint8Array | null {
  const value = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1)
    return null;
  try {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function inRange(value: number, limits: { min: number; max: number }): boolean {
  return Number.isInteger(value) && value >= limits.min && value <= limits.max;
}

function decimal(text: string | undefined, fallback: number): number {
  if (text === undefined || text.trim() === "") return fallback;
  return /^\s*\d{1,4}\s*$/.test(text) ? Number(text) : Number.NaN;
}

function totpOf(
  key: Uint8Array | null,
  algorithm: TotpAlgorithm | null,
  digits: number,
  period: number,
): Totp | undefined {
  if (
    key === null ||
    key.length === 0 ||
    algorithm === null ||
    !inRange(digits, TOTP_LIMITS.digits) ||
    !inRange(period, TOTP_LIMITS.period)
  )
    return undefined;
  return { key, algorithm, digits, period };
}

function timeOtpAlgorithm(text: string | undefined): TotpAlgorithm | null {
  switch ((text ?? "HMAC-SHA-1").trim().toUpperCase()) {
    case "HMAC-SHA-1":
      return "SHA1";
    case "HMAC-SHA-256":
      return "SHA256";
    case "HMAC-SHA-512":
      return "SHA512";
    default:
      return null;
  }
}

function keeOtpAlgorithm(text: string | null): TotpAlgorithm | null {
  switch ((text ?? "Sha1").toLowerCase()) {
    case "sha1":
      return "SHA1";
    case "sha256":
      return "SHA256";
    case "sha512":
      return "SHA512";
    default:
      return null;
  }
}

function uriCandidate(value: string): Candidate {
  const parsed = parseOtpUri(value);
  if (!parsed.ok) return { keys: ["otp"], problem: parsed.problem };
  const { secret, algorithm, digits, period } = parsed.params;
  return {
    keys: ["otp"],
    totp: totpOf(decodeTotpSecret(secret), algorithm, digits, period),
    uri: parsed.normalized,
  };
}

function keeOtpCandidate(value: string): Candidate {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(value.trim());
  } catch {
    return { keys: ["otp"] };
  }
  const type = (params.get("type") ?? "totp").toLowerCase();
  if (!params.has("key") || type !== "totp") return { keys: ["otp"] };
  return {
    keys: ["otp"],
    totp: totpOf(
      decodeTotpSecret(params.get("key") ?? ""),
      keeOtpAlgorithm(params.get("otpHashMode")),
      decimal(params.get("size") ?? undefined, TOTP_DEFAULTS.digits),
      decimal(params.get("step") ?? undefined, TOTP_DEFAULTS.period),
    ),
  };
}

function seedCandidate(
  seed: string,
  settings: string | undefined,
  keys: string[],
): Candidate {
  if (/^otpauth:/i.test(seed.trim())) return { ...uriCandidate(seed), keys };
  const [period, digits] = (settings ?? "30;6").split(";");
  // `<period>;S` is Steam, which v1 does not support.
  return {
    keys,
    totp: totpOf(
      decodeTotpSecret(seed),
      "SHA1",
      decimal(digits, TOTP_DEFAULTS.digits),
      decimal(period, TOTP_DEFAULTS.period),
    ),
  };
}

function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Converts the OTP strings of one entry state. */
export function convertOtp(
  strings: readonly KdbxString[],
  title: string,
  username: string,
): OtpConversion {
  const values = new Map<string, string>();
  for (const item of strings)
    if (!values.has(item.key)) values.set(item.key, item.value);
  const consumed = new Set<string>();
  // Empty OTP strings carry nothing; they are dropped.
  for (const key of ["otp", ...TIME_OTP_KEYS, ...SEED_KEYS])
    if (values.get(key)?.trim() === "") {
      consumed.add(key);
      values.delete(key);
    }

  const otp = values.get("otp");
  const fromUri =
    otp !== undefined && /^otpauth:/i.test(otp.trim())
      ? uriCandidate(otp)
      : undefined;
  const others: Candidate[] = [];
  const timeKeys = TIME_OTP_KEYS.filter((key) => values.has(key));
  if (timeKeys.length > 0) {
    let key: Uint8Array | null = null;
    for (const [name, decode] of TIME_OTP_SECRETS) {
      const text = values.get(name);
      if (text !== undefined) {
        key = decode(text);
        break;
      }
    }
    others.push({
      keys: timeKeys,
      totp: totpOf(
        key,
        timeOtpAlgorithm(values.get("TimeOtp-Algorithm")),
        decimal(values.get("TimeOtp-Length"), TOTP_DEFAULTS.digits),
        decimal(values.get("TimeOtp-Period"), TOTP_DEFAULTS.period),
      ),
    });
  }
  const seed = values.get("TOTP Seed");
  if (seed !== undefined)
    others.push(
      seedCandidate(
        seed,
        values.get("TOTP Settings"),
        SEED_KEYS.filter((key) => values.has(key)),
      ),
    );
  if (otp !== undefined && fromUri === undefined)
    others.push(keeOtpCandidate(otp));

  const primary = fromUri ?? others.find((candidate) => candidate.totp);
  const result: OtpConversion = { otp: null, consumed, unconverted: [] };
  if (primary !== undefined) {
    for (const key of primary.keys) consumed.add(key);
    if (primary.totp === undefined) {
      // Only an otpauth URI v1 cannot use gets here: kept unchanged.
      result.otp = otp ?? null;
      result.kept = primary.problem;
    } else {
      result.otp =
        primary.uri ?? buildTotpUri({ ...primary.totp, title, username });
    }
  }
  for (const candidate of others) {
    if (candidate === primary) continue;
    const same =
      candidate.totp !== undefined &&
      primary?.totp !== undefined &&
      sameKey(candidate.totp.key, primary.totp.key);
    for (const key of candidate.keys)
      if (same) consumed.add(key);
      else if (!consumed.has(key)) result.unconverted.push(key);
  }
  return result;
}

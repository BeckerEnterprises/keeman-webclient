/**
 * TOTP codes (RFC 6238). HMAC comes from WebCrypto, the only crypto
 * outside libsodium apart from KDBX files; times are server times.
 */
import {
  decodeTotpSecret,
  parseOtpUri,
  type OtpProblem,
  type TotpAlgorithm,
  type TotpParams,
} from "./uri";

const HASHES: Record<TotpAlgorithm, string> = {
  SHA1: "SHA-1",
  SHA256: "SHA-256",
  SHA512: "SHA-512",
};

export interface TotpCode {
  code: string;
  /** The code of the next time step. */
  next: string;
  digits: number;
  period: number;
  /** End of the current time step, in server time (ms). */
  validUntil: number;
}

export type TotpResult =
  { ok: true; value: TotpCode } | { ok: false; problem: OtpProblem };

/** The code for one counter value: HMAC and dynamic truncation (RFC 4226). */
export async function hotpCode(
  key: Uint8Array,
  counter: number,
  algorithm: TotpAlgorithm,
  digits: number,
): Promise<string> {
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: HASHES[algorithm] },
    false,
    ["sign"],
  );
  const mac = new DataView(
    await crypto.subtle.sign("HMAC", cryptoKey, message),
  );
  const offset = mac.getUint8(mac.byteLength - 1) & 0x0f;
  const binary = mac.getUint32(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** The current and the next code at `nowMs` (server time). */
export async function totpAt(
  params: TotpParams,
  nowMs: number,
): Promise<TotpCode> {
  const key = decodeTotpSecret(params.secret);
  if (key === null) throw new RangeError("Invalid TOTP secret");
  const step = params.period * 1000;
  const counter = Math.floor(nowMs / step);
  try {
    const [code, next] = await Promise.all([
      hotpCode(key, counter, params.algorithm, params.digits),
      hotpCode(key, counter + 1, params.algorithm, params.digits),
    ]);
    return {
      code,
      next,
      digits: params.digits,
      period: params.period,
      validUntil: (counter + 1) * step,
    };
  } finally {
    key.fill(0);
  }
}

/** Codes of an `otp` value; HOTP, Steam and unreadable values report why not. */
export async function totpFromUri(
  uri: string,
  nowMs: number,
): Promise<TotpResult> {
  const parsed = parseOtpUri(uri);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  return { ok: true, value: await totpAt(parsed.params, nowMs) };
}

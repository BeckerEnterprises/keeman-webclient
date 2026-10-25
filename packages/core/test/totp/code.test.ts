import { describe, expect, it } from "vitest";
import { toBase32 } from "../../src/crypto/base32";
import { hotpCode, totpAt, totpFromUri } from "../../src/totp/code";
import { decodeTotpSecret } from "../../src/totp/uri";

const SEED = new TextEncoder().encode("12345678901234567890");
const SECRET = toBase32(SEED);

describe("TOTP codes (RFC 6238)", () => {
  it("matches RFC 6238 appendix B literally", async () => {
    const at = (time: number) =>
      totpAt(
        { secret: SECRET, algorithm: "SHA1", digits: 8, period: 30 },
        time * 1000,
      );
    expect((await at(59)).code).toBe("94287082");
    expect((await at(1111111109)).code).toBe("07081804");
    expect((await at(20000000000)).code).toBe("65353130");
  });

  it("writes counters above 2^32 in both halves", async () => {
    expect(await hotpCode(SEED, 2 ** 32 + 1, "SHA1", 8)).toBe("39108930");
    expect(await hotpCode(SEED, 2 ** 33 + 5, "SHA1", 8)).toBe("64065679");
  });

  it("gives the next code and the end of the step", async () => {
    const params = {
      secret: SECRET,
      algorithm: "SHA1" as const,
      digits: 6,
      period: 30,
    };
    const first = await totpAt(params, 29_999);
    const second = await totpAt(params, 30_000);
    expect(first.validUntil).toBe(30_000);
    expect(second.validUntil).toBe(60_000);
    expect(first.next).toBe(second.code);
    expect(first).toMatchObject({ digits: 6, period: 30 });
    expect(first.code).toMatch(/^\d{6}$/);
  });

  it("refuses an invalid secret", async () => {
    await expect(
      totpAt({ secret: "1", algorithm: "SHA1", digits: 6, period: 30 }, 0),
    ).rejects.toThrow(RangeError);
  });

  it("reads codes from otp values and reports what v1 cannot use", async () => {
    const uri = `otpauth://totp/x?secret=${SECRET}&algorithm=SHA1&digits=8`;
    expect(await totpFromUri(uri, 59_000)).toMatchObject({
      ok: true,
      value: { code: "94287082", digits: 8, period: 30, validUntil: 60_000 },
    });
    expect(
      await totpFromUri("otpauth://hotp/x?secret=MFRGG&counter=1", 0),
    ).toEqual({ ok: false, problem: "hotp" });
    expect(await totpFromUri("not a uri", 0)).toEqual({
      ok: false,
      problem: "not_otpauth",
    });
  });

  it("decodes secrets leniently and drops fill bits", () => {
    expect(decodeTotpSecret("gezd gnbv")).toEqual(
      new TextEncoder().encode("12345"),
    );
    expect(decodeTotpSecret("MFRGH")).toEqual(
      Uint8Array.from([0x61, 0x62, 0x63]),
    );
    expect(decodeTotpSecret("MFRGG===")).toEqual(
      Uint8Array.from([0x61, 0x62, 0x63]),
    );
    expect(decodeTotpSecret("M")).toBeNull();
    expect(decodeTotpSecret("")).toBeNull();
  });
});

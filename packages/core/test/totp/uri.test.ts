import { describe, expect, it } from "vitest";
import {
  buildTotpUri,
  normalizeTotpSecret,
  parseOtpUri,
} from "../../src/totp/uri";

const KEY = Uint8Array.from([
  0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef,
]);

describe("normalizeTotpSecret", () => {
  it("removes spaces, uppercases and tolerates missing padding", () => {
    expect(normalizeTotpSecret("jbsw y3dp ehpk 3pxp")).toBe("JBSWY3DPEHPK3PXP");
    expect(normalizeTotpSecret("MFRGG")).toBe("MFRGG");
    expect(normalizeTotpSecret("MFRGG===")).toBe("MFRGG");
  });

  it("rejects empty secrets, foreign characters and impossible lengths", () => {
    expect(normalizeTotpSecret("")).toBeNull();
    expect(normalizeTotpSecret("   ")).toBeNull();
    expect(normalizeTotpSecret("JBSW1Y3D")).toBeNull();
    expect(normalizeTotpSecret("ABC")).toBeNull();
    expect(normalizeTotpSecret("MFRGG==")).toBeNull();
    expect(normalizeTotpSecret("=")).toBeNull();
  });
});

describe("parseOtpUri", () => {
  it("reads the KeePassXC form and normalises only the secret", () => {
    const uri =
      "otpauth://totp/test:username?secret=jbsw%20y3dp%20ehpk%203pxp&period=30&digits=6&issuer=test";
    const result = parseOtpUri(uri);
    expect(result).toEqual({
      ok: true,
      params: {
        secret: "JBSWY3DPEHPK3PXP",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      },
      normalized:
        "otpauth://totp/test:username?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&issuer=test",
    });
  });

  it("applies defaults and accepts other algorithms, digits and periods", () => {
    expect(parseOtpUri("otpauth://totp/x?secret=MFRGG")).toMatchObject({
      ok: true,
      params: { algorithm: "SHA1", digits: 6, period: 30 },
    });
    expect(
      parseOtpUri(
        "OTPAUTH://TOTP/x?SECRET=MFRGG&algorithm=sha-512&digits=8&period=60#frag",
      ),
    ).toEqual({
      ok: true,
      params: { secret: "MFRGG", algorithm: "SHA512", digits: 8, period: 60 },
      normalized:
        "otpauth://TOTP/x?secret=MFRGG&algorithm=sha-512&digits=8&period=60#frag",
    });
    expect(
      parseOtpUri("otpauth://totp/?secret=MFRGG&algorithm=SHA256&period=15"),
    ).toMatchObject({ ok: true, params: { algorithm: "SHA256", period: 15 } });
  });

  it("keeps the first of duplicated parameters", () => {
    expect(
      parseOtpUri("otpauth://totp/x?secret=MFRGG&digits=7&digits=9&secret=X1"),
    ).toMatchObject({
      ok: true,
      params: { secret: "MFRGG", digits: 7 },
      normalized: "otpauth://totp/x?secret=MFRGG&digits=7&digits=9&secret=X1",
    });
  });

  it("ignores undecodable parameters other than the secret", () => {
    expect(
      parseOtpUri("otpauth://totp/x?issuer=%E0%A4%A&secret=MFRGG&flag"),
    ).toMatchObject({ ok: true, params: { secret: "MFRGG" } });
  });

  it.each([
    ["https://example.com", "not_otpauth"],
    ["otpauth://totp", "not_otpauth"],
    ["otpauth://motp/x?secret=MFRGG", "not_otpauth"],
    ["otpauth://hotp/x?secret=MFRGG&counter=1", "hotp"],
    ["otpauth://totp/x?secret=MFRGG&encoder=Steam", "steam"],
    ["otpauth://totp/x?period=30", "secret"],
    ["otpauth://totp/x?secret=", "secret"],
    ["otpauth://totp/x?secret=%E0%A4%A", "secret"],
    ["otpauth://totp/x?secret=MFRG1", "secret"],
    ["otpauth://totp/x?secret=MFRGG&algorithm=MD5", "algorithm"],
    ["otpauth://totp/x?secret=MFRGG&digits=5", "digits"],
    ["otpauth://totp/x?secret=MFRGG&digits=six", "digits"],
    ["otpauth://totp/x?secret=MFRGG&period=301", "period"],
    ["otpauth://totp/x?secret=MFRGG&period=14", "period"],
  ])("rejects %s (%s)", (uri, problem) => {
    expect(parseOtpUri(uri)).toEqual({ ok: false, problem });
  });
});

describe("buildTotpUri", () => {
  it("writes title, username and issuer and leaves out defaults", () => {
    const uri = buildTotpUri({ key: KEY, title: "Mail & Co", username: "a b" });
    expect(uri).toBe(
      "otpauth://totp/Mail%20%26%20Co:a%20b?secret=JBSWY3DPEHPK3PXP&issuer=Mail%20%26%20Co",
    );
    expect(parseOtpUri(uri)).toMatchObject({
      ok: true,
      params: { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1" },
    });
  });

  it("writes non-default parameters and drops empty label parts", () => {
    expect(
      buildTotpUri({
        key: KEY,
        title: "",
        username: "user",
        algorithm: "SHA256",
        digits: 8,
        period: 60,
      }),
    ).toBe(
      "otpauth://totp/user?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60",
    );
    expect(buildTotpUri({ key: KEY, title: "", username: "" })).toBe(
      "otpauth://totp/?secret=JBSWY3DPEHPK3PXP",
    );
  });

  it("refuses empty keys and parameters out of range", () => {
    const base = { title: "t", username: "u" };
    expect(() => buildTotpUri({ ...base, key: new Uint8Array() })).toThrow(
      RangeError,
    );
    expect(() => buildTotpUri({ ...base, key: KEY, digits: 9 })).toThrow(
      RangeError,
    );
    expect(() => buildTotpUri({ ...base, key: KEY, period: 7.5 })).toThrow(
      RangeError,
    );
  });
});

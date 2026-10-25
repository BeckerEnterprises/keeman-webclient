import { describe, expect, it } from "vitest";
import { convertOtp } from "../../src/kdbx/otp";
import type { KdbxString } from "../../src/kdbx/types";

function strings(values: Record<string, string>): KdbxString[] {
  return Object.entries(values).map(([key, value]) => ({
    key,
    value,
    protected: key !== "Title",
  }));
}

const convert = (values: Record<string, string>) =>
  convertOtp(strings(values), "Mail & Co", "a@b");

describe("convertOtp", () => {
  it("normalises a KeePassXC otp URI and drops other strings with the same secret", () => {
    const result = convert({
      otp: "otpauth://totp/x?secret=jbsw%20y3dp%20ehpk%203pxp&issuer=x",
      "TOTP Seed": "JBSWY3DPEHPK3PXP",
      "TOTP Settings": "30;6",
    });
    expect(result).toEqual({
      otp: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&issuer=x",
      consumed: new Set(["otp", "TOTP Seed", "TOTP Settings"]),
      unconverted: [],
    });
  });

  it("keeps HOTP, Steam and unreadable otpauth URIs unchanged", () => {
    for (const [uri, problem] of [
      ["otpauth://hotp/x?secret=MFRGG&counter=1", "hotp"],
      ["otpauth://totp/x?secret=MFRGG&encoder=steam", "steam"],
      ["otpauth://totp/x?secret=1", "secret"],
    ] as const) {
      const result = convert({ otp: uri, "TimeOtp-Secret-Base32": "MFRGG" });
      expect(result.otp).toBe(uri);
      expect(result.kept).toBe(problem);
      expect(result.consumed).toEqual(new Set(["otp"]));
      expect(result.unconverted).toEqual(["TimeOtp-Secret-Base32"]);
    }
  });

  it("converts KeePass 2 TimeOtp strings in every encoding", () => {
    const expected =
      "otpauth://totp/Mail%20%26%20Co:a%40b?secret=JBSWY3DPEHPK3PXP&issuer=Mail%20%26%20Co";
    expect(
      convert({ "TimeOtp-Secret-Base32": "jbsw y3dp ehpk 3pxp" }).otp,
    ).toBe(expected);
    expect(
      convert({ "TimeOtp-Secret-Hex": "48 65 6C 6c 6f 21 de ad be ef" }).otp,
    ).toBe(expected);
    expect(convert({ "TimeOtp-Secret-Base64": "SGVsbG8h3q2+7w==" }).otp).toBe(
      expected,
    );
    const utf8 = convert({
      "TimeOtp-Secret": "12345678901234567890",
      "TimeOtp-Length": "8",
      "TimeOtp-Period": "60",
      "TimeOtp-Algorithm": "HMAC-SHA-256",
    });
    expect(utf8.otp).toBe(
      "otpauth://totp/Mail%20%26%20Co:a%40b?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Mail%20%26%20Co&algorithm=SHA256&digits=8&period=60",
    );
    expect(utf8.consumed).toEqual(
      new Set([
        "TimeOtp-Secret",
        "TimeOtp-Length",
        "TimeOtp-Period",
        "TimeOtp-Algorithm",
      ]),
    );
    expect(
      convert({
        "TimeOtp-Secret-Base32": "MFRGG",
        "TimeOtp-Algorithm": "HMAC-SHA-512",
      }).otp,
    ).toContain("algorithm=SHA512");
  });

  it("leaves TimeOtp strings it cannot use as fields", () => {
    const cases: Record<string, string>[] = [
      { "TimeOtp-Secret-Hex": "4865z" },
      { "TimeOtp-Secret-Base64": "!!!" },
      { "TimeOtp-Secret-Base64": "QUJD=" },
      { "TimeOtp-Secret-Base32": "MFRGG", "TimeOtp-Length": "9" },
      { "TimeOtp-Secret-Base32": "MFRGG", "TimeOtp-Period": "x" },
      { "TimeOtp-Secret-Base32": "MFRGG", "TimeOtp-Algorithm": "HMAC-MD5" },
      { "TimeOtp-Length": "6" },
    ];
    for (const values of cases) {
      const result = convert(values);
      expect(result.otp).toBeNull();
      expect(result.unconverted).toEqual(Object.keys(values));
    }
  });

  it("converts TOTP Seed with settings, but not Steam", () => {
    expect(
      convert({ "TOTP Seed": "JBSWY3DPEHPK3PXP", "TOTP Settings": "60;8" }).otp,
    ).toBe(
      "otpauth://totp/Mail%20%26%20Co:a%40b?secret=JBSWY3DPEHPK3PXP&issuer=Mail%20%26%20Co&digits=8&period=60",
    );
    expect(convert({ "TOTP Seed": "JBSWY3DPEHPK3PXP" }).otp).toContain(
      "secret=JBSWY3DPEHPK3PXP&issuer",
    );
    expect(
      convert({ "TOTP Seed": "otpauth://totp/s?secret=MFRGG&digits=7" }).otp,
    ).toBe("otpauth://totp/s?secret=MFRGG&digits=7");
    const steam = convert({ "TOTP Seed": "MFRGG", "TOTP Settings": "30;S" });
    expect(steam.otp).toBeNull();
    expect(steam.unconverted).toEqual(["TOTP Seed", "TOTP Settings"]);
  });

  it("converts KeeOtp and leaves other otp strings as fields", () => {
    expect(
      convert({
        otp: "key=JBSWY3DPEHPK3PXP&size=8&step=45&type=Totp&otpHashMode=Sha512",
      }).otp,
    ).toBe(
      "otpauth://totp/Mail%20%26%20Co:a%40b?secret=JBSWY3DPEHPK3PXP&issuer=Mail%20%26%20Co&algorithm=SHA512&digits=8&period=45",
    );
    expect(convert({ otp: "key=MFRGG&otpHashMode=sha256" }).otp).toContain(
      "algorithm=SHA256",
    );
    for (const otp of [
      "key=MFRGG&type=Hotp&counter=1",
      "key=MFRGG&otpHashMode=Md5",
      "no key here",
    ]) {
      const result = convert({ otp });
      expect(result.otp).toBeNull();
      expect(result.unconverted).toEqual(["otp"]);
    }
  });

  it("prefers TimeOtp over a seed and keeps a different secret as fields", () => {
    const result = convert({
      "TimeOtp-Secret-Base32": "JBSWY3DPEHPK3PXP",
      "TOTP Seed": "MFRGG",
      otp: "key=JBSWY3DPEHPK3PXP",
    });
    expect(result.otp).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(result.unconverted).toEqual(["TOTP Seed"]);
    expect(result.consumed).toEqual(new Set(["TimeOtp-Secret-Base32", "otp"]));
  });

  it("drops empty OTP strings and ignores entries without any", () => {
    expect(convert({ otp: "", "TOTP Seed": " ", Title: "x" })).toEqual({
      otp: null,
      consumed: new Set(["otp", "TOTP Seed"]),
      unconverted: [],
    });
  });
});

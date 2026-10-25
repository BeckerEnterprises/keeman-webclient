import { describe, expect, it } from "vitest";
import {
  checkNewPassword,
  hasOuterSpace,
  loadScorer,
  userInputs,
} from "./password";

describe("password rules", () => {
  const strong = () => 4;

  it("needs 12 code points after NFC, a good score and a matching repetition", () => {
    const base = { email: "alice@example.com", confirmation: "" };
    expect(checkNewPassword({ ...base, password: "short" }, strong)).toContain(
      "too_short",
    );
    // 12 emoji are 12 code points but 24 UTF-16 units.
    const emoji = "🔑".repeat(12);
    expect(
      checkNewPassword(
        { ...base, password: emoji, confirmation: emoji },
        strong,
      ),
    ).toEqual([]);
    expect(
      checkNewPassword(
        { ...base, password: "a".repeat(20), confirmation: "a".repeat(20) },
        () => 2,
      ),
    ).toEqual(["too_weak"]);
    const nfd = "Grüße und Zeit!";
    expect(
      checkNewPassword(
        { ...base, password: "Grüße und Zeit!", confirmation: nfd },
        strong,
      ),
    ).toEqual([]);
    expect(
      checkNewPassword(
        { ...base, password: "x".repeat(12), confirmation: "y" },
        strong,
      ),
    ).toContain("mismatch");
    expect(
      checkNewPassword(
        {
          ...base,
          password: "x".repeat(12),
          confirmation: "x".repeat(12),
          previous: "x".repeat(12),
        },
        strong,
      ),
    ).toContain("unchanged");
    expect(
      checkNewPassword({ ...base, password: "a\ud800bcdefghijklm" }, strong),
    ).toEqual(["malformed"]);
  });

  it("uses the e-mail as guessable input and flags outer spaces", () => {
    expect(userInputs(" Alice@Example.com ")).toEqual([
      "alice@example.com",
      "alice",
      "keeman",
    ]);
    expect(hasOuterSpace(" pw")).toBe(true);
    expect(hasOuterSpace("p w")).toBe(false);
  });

  it("rates with zxcvbn and the German and English dictionaries", async () => {
    const score = await loadScorer();
    expect(score("passwort123", [])).toBeLessThan(3);
    expect(
      score("alice@example.com", userInputs("alice@example.com")),
    ).toBeLessThan(3);
    expect(score("Kiesel Wolke 4f2a91 Laterne", [])).toBeGreaterThanOrEqual(3);
  });
});

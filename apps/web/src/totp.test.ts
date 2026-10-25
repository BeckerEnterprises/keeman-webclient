import { describe, expect, it } from "vitest";
import { groupCode } from "./totp";

describe("groupCode", () => {
  it("splits 6, 7 and 8 digits into two groups", () => {
    expect(groupCode("123456")).toEqual(["123", "456"]);
    expect(groupCode("1234567")).toEqual(["123", "4567"]);
    expect(groupCode("12345678")).toEqual(["1234", "5678"]);
    expect(groupCode("")).toEqual([]);
  });
});

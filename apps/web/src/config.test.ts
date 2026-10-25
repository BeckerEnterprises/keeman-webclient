import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

describe("runtime config", () => {
  it("accepts https and local http, strips the trailing slash", () => {
    expect(parseConfig({ apiUrl: "https://api.example.org/" })).toEqual({
      apiUrl: "https://api.example.org",
    });
    expect(parseConfig({ apiUrl: "http://localhost:18787", extra: 1 })).toEqual(
      { apiUrl: "http://localhost:18787" },
    );
    expect(parseConfig({ apiUrl: "http://[::1]:8788" }).apiUrl).toBe(
      "http://[::1]:8788",
    );
  });

  it.each([
    {},
    { apiUrl: 1 },
    { apiUrl: "api.example.org" },
    { apiUrl: "http://api.example.org" },
    { apiUrl: "https://api.example.org/?x=1" },
    { apiUrl: "https://api.example.org/#x" },
    { apiUrl: "https://user:pw@api.example.org" },
    { apiUrl: "javascript:alert(1)" },
  ])("rejects %o", (data) => {
    expect(() => parseConfig(data)).toThrow();
  });
});

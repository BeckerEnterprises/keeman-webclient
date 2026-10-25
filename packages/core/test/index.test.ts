import { describe, expect, expectTypeOf, it } from "vitest";
import { API_VERSION, type components, type paths } from "../src/index";

describe("@keeman/core", () => {
  it("speaks API version 1", () => {
    expect(API_VERSION).toBe(1);
  });

  it("exposes the generated API types", () => {
    expectTypeOf<
      components["schemas"]["KdfParams"]["alg"]
    >().toEqualTypeOf<"argon2id13">();
    expectTypeOf<
      paths["/v1/health"]["get"]["responses"]["200"]["content"]["application/json"]["status"]
    >().toEqualTypeOf<"ok" | "error">();
  });
});

import type { ResolvedUrl } from "@keeman/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openUrl, urlProblem } from "./open-url";

const WEB = ["http", "https"];

function ok(url: string, warnings: ("cycle" | "missing")[] = []): ResolvedUrl {
  return { ok: true, url, display: url, secret: false, warnings };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("opening URLs", () => {
  it("opens allowed schemes without opener and referrer", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openUrl(ok("https://example.com/?a=b"), WEB)).toBeUndefined();
    expect(open).toHaveBeenCalledWith(
      "https://example.com/?a=b",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openUrl(ok("ssh://root@h"), [...WEB, "ssh"])).toBeUndefined();
  });

  it("refuses forbidden and unlisted schemes, errors and cycles", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    expect(openUrl(ok("javascript:alert(1)"), [...WEB, "javascript"])).toBe(
      "scheme_forbidden",
    );
    expect(openUrl(ok("ssh://root@h"), WEB)).toBe("scheme_not_allowed");
    expect(
      openUrl({ ok: false, error: "invalid_host", warnings: [] }, WEB),
    ).toBe("invalid_host");
    expect(openUrl(ok("https://h/{URL}", ["cycle"]), WEB)).toBe("cycle");
    expect(open).not.toHaveBeenCalled();
  });

  it("lets a missing reference pass", () => {
    expect(urlProblem(ok("https://h/{S:Nope}", ["missing"]), WEB)).toBe(
      undefined,
    );
  });
});

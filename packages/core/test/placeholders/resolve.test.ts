import { describe, expect, it } from "vitest";
import {
  checkScheme,
  resolveText,
  resolveUrl,
  type PlaceholderEntry,
  type PlaceholderLookup,
} from "../../src/placeholders/resolve";

const A = "0192b3a4-0000-7000-8000-00000000000a";
const B = "0192b3a4-0000-7000-8000-00000000000b";
const C = "0192b3a4-0000-7000-8000-00000000000c";
const GONE = "0192b3a4-0000-7000-8000-0000000000ff";
const MASK = "••••••";

function ref(field: string, id: string): string {
  return `{REF:${field}@I:${id.replaceAll("-", "")}}`;
}

function lookup(
  entries: Record<string, Partial<PlaceholderEntry>>,
): PlaceholderLookup {
  return {
    entry: (id) => {
      const entry = entries[id];
      return entry
        ? {
            title: "",
            username: "",
            password: "",
            url: "",
            notes: "",
            fields: [],
            ...entry,
          }
        : undefined;
    },
  };
}

function url(entry: Partial<PlaceholderEntry>, others = {}) {
  return resolveUrl(A, lookup({ [A]: entry, ...others }));
}

describe("resolveUrl", () => {
  it("keeps a plain URL as typed", () => {
    expect(url({ url: "  https://example.com/login?a=b  " })).toEqual({
      ok: true,
      url: "https://example.com/login?a=b",
      display: "https://example.com/login?a=b",
      secret: false,
      warnings: [],
    });
  });

  it("encodes every value for its position and masks secrets", () => {
    const result = url({
      title: "Grüße #1",
      username: "alex@example.com/x",
      password: "p&ss#w?rd/%",
      url: "https://{S:Host}:8443/a b/{USERNAME}?pw={PASSWORD}&x={S:Q}#{TITLE}",
      fields: [
        { name: "host", value: "203.0.113.10", protected: false },
        { name: "Q", value: "a b&c", protected: false },
      ],
    });
    expect(result).toEqual({
      ok: true,
      url: "https://203.0.113.10:8443/a b/alex@example.com/x?pw=p%26ss%23w%3Frd%2F%25&x=a%20b%26c#Gr%C3%BC%C3%9Fe%20%231",
      display: `https://203.0.113.10:8443/a b/alex@example.com/x?pw=${MASK}&x=a%20b%26c#Gr%C3%BC%C3%9Fe%20%231`,
      secret: true,
      warnings: [],
    });
  });

  it("splits the authority at the last `@`", () => {
    expect(
      url({
        username: "a:b@c",
        password: "p@ss",
        url: "https://{USERNAME}:{PASSWORD}@{S:Host}:{S:Port}/",
        fields: [
          { name: "Host", value: "example.com", protected: false },
          { name: "Port", value: "8443", protected: false },
        ],
      }),
    ).toMatchObject({
      url: "https://a%3Ab%40c:p%40ss@example.com:8443/",
      display: `https://a%3Ab%40c:${MASK}@example.com:8443/`,
    });
  });

  it("takes host values raw, but not with separators or spaces", () => {
    const host = (value: string) =>
      url({
        url: "https://[{S:Host}]:8443/",
        fields: [{ name: "Host", value, protected: false }],
      });
    expect(host("2001:db8::1")).toMatchObject({
      url: "https://[2001:db8::1]:8443/",
    });
    for (const value of ["evil.com/x", "a b", "a\tb", "x?y", "x#y", "u@h"])
      expect(host(value), value).toEqual({
        ok: false,
        error: "invalid_host",
        warnings: [],
      });
  });

  it("prepends https:// without a scheme", () => {
    expect(
      url({ username: "alex", url: "example.com/{USERNAME}" }),
    ).toMatchObject({ url: "https://example.com/alex" });
    expect(url({ url: "example.com:8080/x" })).toMatchObject({
      url: "https://example.com:8080/x",
    });
    expect(
      url({
        url: "{S:Host}/path?{TITLE}",
        title: "a b",
        fields: [{ name: "Host", value: "203.0.113.10", protected: false }],
      }),
    ).toMatchObject({ url: "https://203.0.113.10/path?a%20b" });
  });

  it("treats `mailto:` and a scheme before a placeholder as a scheme", () => {
    expect(
      url({ username: "a b@example.com", url: "mailto:{USERNAME}" }),
    ).toMatchObject({ url: "mailto:a%20b@example.com" });
    expect(url({ url: "ssh://root@203.0.113.10:22" })).toMatchObject({
      url: "ssh://root@203.0.113.10:22",
    });
  });

  it("takes a single placeholder unencoded", () => {
    const link = (value: string) =>
      url({
        url: "{S:Link}",
        fields: [{ name: "Link", value, protected: false }],
      });
    expect(link("https://x.example/?a=b c")).toMatchObject({
      url: "https://x.example/?a=b c",
    });
    expect(link("x.example/a")).toMatchObject({ url: "https://x.example/a" });
    expect(link("javascript:alert(1)")).toMatchObject({
      url: "javascript:alert(1)",
    });
    expect(link("")).toMatchObject({ ok: false, error: "invalid_url" });
  });

  it("forbids placeholders in the scheme", () => {
    expect(
      url({
        url: "{S:Proto}://example.com",
        fields: [{ name: "Proto", value: "https", protected: false }],
      }),
    ).toMatchObject({ ok: false, error: "placeholder_in_scheme" });
    expect(url({ url: "{TITLE}/x?to=https://y" })).toMatchObject({
      ok: false,
      error: "placeholder_in_scheme",
    });
  });

  it("tells fragment and query apart", () => {
    expect(
      url({
        username: "u?#",
        url: "https://h/#a?{USERNAME}",
      }),
    ).toMatchObject({ url: "https://h/#a?u%3F%23" });
    expect(
      url({ username: "x/y", url: "https://h/?q={USERNAME}#{USERNAME}" }),
    ).toMatchObject({ url: "https://h/?q=x%2Fy#x%2Fy" });
  });

  it("copies unknown placeholders and stray braces unchanged", () => {
    expect(url({ username: "d", url: "https://h/{{USERNAME}}{FOO}" })).toEqual({
      ok: true,
      url: "https://h/{d}{FOO}",
      display: "https://h/{d}{FOO}",
      secret: false,
      warnings: [],
    });
    expect(url({ url: "https://h/{S:Nope}" })).toMatchObject({
      url: "https://h/{S:Nope}",
      warnings: ["missing"],
    });
  });

  it("calls {URL} in the URL a cycle", () => {
    expect(url({ url: "https://h/{URL}" })).toEqual({
      ok: true,
      url: "https://h/{URL}",
      display: "https://h/{URL}",
      secret: false,
      warnings: ["cycle"],
    });
  });

  it("resolves {REF:A} to the target's URL in its own context", () => {
    expect(
      url(
        { url: ref("A", B) },
        { [B]: { username: "bob", url: "https://b.example/{USERNAME}" } },
      ),
    ).toMatchObject({ url: "https://b.example/bob", secret: false });
    expect(
      url(
        { url: `https://a.example/?next=${ref("A", B)}` },
        { [B]: { password: "pw", url: "https://b.example/{PASSWORD}" } },
      ),
    ).toMatchObject({
      url: "https://a.example/?next=https%3A%2F%2Fb.example%2Fpw",
      display: `https://a.example/?next=${MASK}`,
      secret: true,
    });
  });

  it("keeps a {REF:A} that cannot be resolved", () => {
    expect(
      url(
        { url: `https://a.example/?next=${ref("A", B)}` },
        { [B]: { url: "{S:Proto}://x" } },
      ),
    ).toMatchObject({
      url: `https://a.example/?next=${ref("A", B)}`,
      warnings: ["missing"],
    });
    expect(url({ url: ref("A", B) }, { [B]: { url: ref("A", A) } })).toEqual({
      ok: false,
      error: "invalid_url",
      warnings: ["cycle", "missing"],
    });
  });

  it("reports values that make the URL invalid", () => {
    expect(url({ url: "https://exa mple.com" })).toMatchObject({
      ok: false,
      error: "invalid_url",
    });
    expect(url({ url: "" })).toMatchObject({ ok: false, error: "invalid_url" });
    expect(
      url({ username: "\ud800", url: "https://h/?u={USERNAME}" }),
    ).toMatchObject({ ok: false, error: "invalid_url" });
    expect(resolveUrl(GONE, lookup({}))).toEqual({
      ok: false,
      error: "invalid_url",
      warnings: [],
    });
  });

  it("masks a run of secret parts once", () => {
    expect(
      url({
        password: "pw",
        url: "https://h/?k={PASSWORD}{S:Pin}&x=1",
        fields: [{ name: "Pin", value: "1234", protected: true }],
      }),
    ).toMatchObject({
      url: "https://h/?k=pw1234&x=1",
      display: `https://h/?k=${MASK}&x=1`,
    });
  });
});

describe("resolveText", () => {
  it("resolves REF in any field, also several levels deep", () => {
    const vault = lookup({
      [A]: { username: `${ref("U", B)} (copy)`, title: "no refs" },
      [B]: { username: ref("U", C) },
      [C]: { username: "carol" },
    });
    expect(resolveText(A, "username", vault)).toEqual({
      value: "carol (copy)",
      display: "carol (copy)",
      secret: false,
      refs: true,
      warnings: [],
    });
    expect(resolveText(A, "title", vault)).toMatchObject({
      value: "no refs",
      refs: false,
    });
  });

  it("marks secret values and masks them", () => {
    const vault = lookup({
      [A]: {
        username: ref("P", B),
        password: `x${ref("U", B)}`,
        fields: [
          { name: "Pin", value: "1234", protected: true },
          { name: "Note", value: ref("N", B), protected: false },
        ],
      },
      [B]: { username: "bob", password: "secret", notes: "line" },
    });
    expect(resolveText(A, "username", vault)).toMatchObject({
      value: "secret",
      display: MASK,
      secret: true,
    });
    expect(resolveText(A, "password", vault)).toMatchObject({
      value: "xbob",
      secret: true,
    });
    expect(resolveText(A, { custom: 0 }, vault)).toMatchObject({
      value: "1234",
      secret: true,
      refs: false,
    });
    expect(resolveText(A, { custom: 1 }, vault)).toMatchObject({
      value: "line",
      secret: false,
    });
    expect(resolveText(A, { custom: 5 }, vault)).toMatchObject({ value: "" });
  });

  it("leaves other placeholders in values as text", () => {
    const vault = lookup({
      [A]: { notes: `{USERNAME} ${ref("T", B)}`, username: "u" },
      [B]: { title: "{PASSWORD}" },
    });
    expect(resolveText(A, "notes", vault).value).toBe("{USERNAME} {PASSWORD}");
  });

  it("keeps missing targets and cycles", () => {
    const vault = lookup({
      [A]: { title: `${ref("T", GONE)}/${ref("T", B)}` },
      [B]: { title: ref("T", A) },
    });
    expect(resolveText(A, "title", vault)).toMatchObject({
      value: `${ref("T", GONE)}/${ref("T", A)}`,
      warnings: ["cycle", "missing"],
    });
    expect(resolveText(GONE, "title", vault)).toMatchObject({ value: "" });
  });

  it("allows 10 nested references, not 11", () => {
    const chain = (length: number) => {
      const ids = Array.from(
        { length: length + 1 },
        (_, i) => `0192b3a4-0000-7000-8000-${String(i).padStart(12, "0")}`,
      );
      const entries: Record<string, Partial<PlaceholderEntry>> = {};
      ids.forEach((id, i) => {
        const next = ids[i + 1];
        entries[id] = { title: next === undefined ? "end" : ref("T", next) };
      });
      return resolveText(ids[0] ?? "", "title", lookup(entries));
    };
    expect(chain(10)).toMatchObject({ value: "end", warnings: [] });
    expect(chain(11)).toMatchObject({
      value: ref("T", "0192b3a4-0000-7000-8000-000000000011"),
      warnings: ["cycle"],
    });
  });

  it("resolves only T, U and A without secrets or notes for lists", () => {
    const vault = lookup({
      [A]: {
        title: [ref("T", B), ref("U", B), ref("P", B), ref("N", B)].join("|"),
        username: ref("A", B),
        url: `${ref("A", C)} ${ref("A", GONE)}`,
      },
      [B]: {
        title: "t",
        username: "u",
        password: "p",
        notes: "n",
        url: "https://b.example/{USERNAME}",
      },
      [C]: { url: "https://c.example/{NOTES}" },
    });
    const list = (field: "title" | "username" | "url") =>
      resolveText(A, field, vault, { restricted: true });
    expect(list("title").value).toBe(
      ["t", "u", ref("P", B), ref("N", B)].join("|"),
    );
    expect(list("username").value).toBe("https://b.example/u");
    expect(list("url")).toMatchObject({
      value: `${ref("A", C)} ${ref("A", GONE)}`,
      warnings: ["missing"],
    });
    expect(
      resolveText(
        A,
        "username",
        lookup({
          [A]: { username: ref("A", B) },
          [B]: { password: "p", url: "https://b/{PASSWORD}" },
        }),
        { restricted: true },
      ).value,
    ).toBe(ref("A", B));
  });
});

describe("checkScheme", () => {
  const web = ["http", "https"];

  it("allows the listed schemes without regard to case", () => {
    expect(checkScheme("https://example.com", web)).toBeUndefined();
    expect(checkScheme("HTTP://example.com", web)).toBeUndefined();
    expect(checkScheme("ssh://root@h", ["SSH"])).toBeUndefined();
  });

  it("names schemes that are not allowed", () => {
    expect(checkScheme("ssh://root@h", web)).toBe("scheme_not_allowed");
    expect(checkScheme("mailto:a@b", web)).toBe("scheme_not_allowed");
    expect(checkScheme("not a url", web)).toBe("scheme_not_allowed");
  });

  it("never allows the forbidden schemes", () => {
    const all = ["javascript", "data", "file", "blob", "vbscript", "about"];
    for (const value of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "blob:https://h/0192b3a4",
      "vbscript:x",
      "about:blank",
    ])
      expect(checkScheme(value, all), value).toBe("scheme_forbidden");
  });
});

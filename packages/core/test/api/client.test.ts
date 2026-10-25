import { describe, expect, it, vi } from "vitest";
import { ApiClient, type RefreshCoordinator } from "../../src/api/client";
import { ApiError, NetworkError } from "../../src/api/errors";
import {
  json,
  problem,
  scriptedFetch,
  TOKEN_A,
  TOKEN_B,
  TOKEN_C,
  tokenResponse,
} from "./fake-fetch";

const BASE = "http://localhost:18787/";
const USER = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b";
const SESSION = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6c";

function client(
  fetch: typeof globalThis.fetch,
  extra: { now?: () => number; coordinator?: RefreshCoordinator } = {},
) {
  const sleeps: number[] = [];
  const api = new ApiClient({
    baseUrl: BASE,
    clientId: "web/0.1.0",
    fetch,
    now: extra.now ?? (() => 1_000_000),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    coordinator: extra.coordinator,
  });
  return { api, sleeps };
}

function sessionResponse(token = TOKEN_A): Response {
  return json(200, {
    status: "ok",
    session_id: SESSION,
    user_id: USER,
    access_token: token,
    access_expires_in: 900,
  });
}

const MY_SESSIONS = {
  sessions: [
    {
      id: SESSION,
      device_name: "Firefox · Linux",
      client_type: "web",
      created: "2026-10-23T08:00:00.000Z",
      last_seen: "2026-10-23T08:00:00.000Z",
      ip_hint: null,
      current: true,
    },
  ],
};

describe("ApiClient requests", () => {
  it("sends the client id, JSON and cookies only where needed", async () => {
    const { fetch, requests } = scriptedFetch(
      () =>
        json(200, {
          server_version: "0.1.0",
          api_version: 1,
          registration: "invite",
          features: { favicon: true },
          limits: { attachment_max_bytes: 52_428_800, batch_max_ops: 500 },
          extra: true,
        }),
      () => sessionResponse(),
      () => json(200, MY_SESSIONS),
    );
    const { api } = client(fetch);
    expect(await api.config()).toEqual({
      server_version: "0.1.0",
      api_version: 1,
      registration: "invite",
      features: { favicon: true },
      limits: { attachment_max_bytes: 52_428_800 },
    });
    await api.login({
      email: "a@example.com",
      auth_key: TOKEN_C,
      device: { name: "x", client_type: "web" },
    });
    expect((await api.sessions())[0]?.current).toBe(true);

    const [config, login, sessions] = requests;
    expect(config).toMatchObject({
      method: "GET",
      url: "http://localhost:18787/v1/config",
      credentials: "omit",
      redirect: "error",
    });
    expect(config?.headers["x-keeman-client"]).toBe("web/0.1.0");
    expect(config?.headers.authorization).toBeUndefined();
    expect(login).toMatchObject({ method: "POST", credentials: "include" });
    expect(login?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(login?.body ?? "")).toMatchObject({
      email: "a@example.com",
    });
    expect(sessions?.headers.authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(sessions?.credentials).toBe("omit");
  });

  it("sends register bodies byte for byte", async () => {
    const body = '{"user_id":"x", "spaces": true}';
    const { fetch, requests } = scriptedFetch(() => sessionResponse());
    const { api } = client(fetch);
    expect(await api.register(body)).toEqual({
      sessionId: SESSION,
      userId: USER,
    });
    expect(requests[0]?.body).toBe(body);
    expect(requests[0]?.credentials).toBe("include");
  });

  it("maps problem details to ApiError without detail texts", async () => {
    const { fetch } = scriptedFetch(
      () =>
        problem(
          429,
          "rate_limited",
          { detail: "secret detail" },
          { "retry-after": "42" },
        ),
      () => problem(409, "conflict", { current_revision: 7 }),
      () => problem(400, "brand_new_code"),
      () => new Response("oops", { status: 502 }),
    );
    const { api } = client(fetch);
    api.setAccessToken({ token: TOKEN_A, expiresAt: 2_000_000 });
    const rateLimited = await api
      .prelogin("a@example.com")
      .catch((e: unknown) => e);
    expect(rateLimited).toBeInstanceOf(ApiError);
    expect(rateLimited).toMatchObject({
      status: 429,
      code: "rate_limited",
      details: {
        retryAfter: 42,
        instance: "urn:uuid:0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
      },
    });
    expect((rateLimited as Error).message).not.toContain("secret");
    await expect(api.putUserData(3, "AQ")).rejects.toMatchObject({
      code: "conflict",
      details: { currentRevision: 7 },
    });
    await expect(api.prelogin("a@example.com")).rejects.toMatchObject({
      code: "unknown",
    });
    await expect(api.prelogin("a@example.com")).rejects.toMatchObject({
      status: 502,
      code: "unknown",
    });
  });

  it("treats network failures, timeouts and malformed answers as NetworkError", async () => {
    const timeout = new DOMException("t", "TimeoutError");
    const { fetch } = scriptedFetch(
      () => Promise.reject(new TypeError("failed")),
      () => Promise.reject(timeout),
      () => json(200, { kdf: {}, salt: "too-short" }),
      () => new Response("not json", { status: 200 }),
    );
    const { api } = client(fetch);
    await expect(api.prelogin("a@example.com")).rejects.toEqual(
      new NetworkError("network"),
    );
    await expect(api.prelogin("a@example.com")).rejects.toEqual(
      new NetworkError("timeout"),
    );
    await expect(api.prelogin("a@example.com")).rejects.toEqual(
      new NetworkError("response"),
    );
    await expect(api.prelogin("a@example.com")).rejects.toEqual(
      new NetworkError("response"),
    );
  });

  it("retries reading requests twice, writing requests never", async () => {
    const { fetch, requests } = scriptedFetch(
      () => Promise.reject(new TypeError("failed")),
      () => problem(503, "internal_error"),
      () => json(200, MY_SESSIONS),
      () => Promise.reject(new TypeError("failed")),
      () => problem(500, "internal_error"),
      () => problem(500, "internal_error"),
      () => problem(500, "internal_error"),
    );
    const { api, sleeps } = client(fetch);
    api.setAccessToken({ token: TOKEN_A, expiresAt: 2_000_000 });
    expect(await api.sessions()).toHaveLength(1);
    expect(sleeps).toEqual([300, 1000]);
    await expect(api.revokeOtherSessions()).rejects.toBeInstanceOf(
      NetworkError,
    );
    await expect(api.sessions()).rejects.toMatchObject({ status: 500 });
    expect(requests).toHaveLength(7);
    expect(requests[3]?.url).toContain("/v1/me/sessions?scope=others");
  });
});

describe("ApiClient tokens", () => {
  it("refreshes on demand when the token is missing or expired", async () => {
    let now = 1_000_000;
    const { fetch, requests } = scriptedFetch(
      () => tokenResponse(TOKEN_A),
      () => json(200, MY_SESSIONS),
      () => tokenResponse(TOKEN_B),
      () => json(200, MY_SESSIONS),
    );
    const { api } = client(fetch, { now: () => now });
    await api.sessions();
    now += 871_000; // 900 s minus the 30 s margin, plus 1 s
    await api.sessions();
    expect(requests.map((r) => r.url.replace(/^.*\/v1/, ""))).toEqual([
      "/auth/refresh",
      "/me/sessions",
      "/auth/refresh",
      "/me/sessions",
    ]);
    expect(requests[0]?.credentials).toBe("include");
    expect(requests[3]?.headers.authorization).toBe(`Bearer ${TOKEN_B}`);
  });

  it("refreshes once and retries after 401 session_invalid", async () => {
    const { fetch, requests } = scriptedFetch(
      () => problem(401, "session_invalid"),
      () => tokenResponse(TOKEN_B),
      () => json(200, MY_SESSIONS),
      () => problem(401, "invalid_credentials"),
    );
    const { api } = client(fetch);
    api.setAccessToken({ token: TOKEN_A, expiresAt: 2_000_000 });
    await api.sessions();
    expect(requests[2]?.headers.authorization).toBe(`Bearer ${TOKEN_B}`);
    // Wrong auth_key on reauth is not a dead session.
    await expect(api.reauth(TOKEN_C)).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    expect(requests).toHaveLength(4);
  });

  it("gives up after a second 401 and forgets the token when refresh fails", async () => {
    const { fetch } = scriptedFetch(
      () => problem(401, "session_invalid"),
      () => problem(401, "session_invalid"),
    );
    const { api } = client(fetch);
    api.setAccessToken({ token: TOKEN_A, expiresAt: 2_000_000 });
    await expect(api.sessions()).rejects.toMatchObject({
      code: "session_invalid",
    });
    expect(api.hasAccessToken).toBe(false);
  });

  it("shares one refresh between concurrent requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetch, requests } = scriptedFetch(
      async () => {
        await gate;
        return tokenResponse(TOKEN_A);
      },
      () => json(200, MY_SESSIONS),
      () => json(200, MY_SESSIONS),
    );
    const { api } = client(fetch);
    const both = Promise.all([api.sessions(), api.sessions()]);
    release();
    await both;
    expect(
      requests.filter((r) => r.url.endsWith("/auth/refresh")),
    ).toHaveLength(1);
  });

  it("retries refresh_superseded twice, then gives up", async () => {
    const { fetch, requests } = scriptedFetch(
      () => problem(409, "refresh_superseded"),
      () => problem(409, "refresh_superseded"),
      () => tokenResponse(TOKEN_A),
      () => problem(409, "refresh_superseded"),
      () => problem(409, "refresh_superseded"),
      () => problem(409, "refresh_superseded"),
    );
    const { api, sleeps } = client(fetch);
    await api.refresh();
    expect(sleeps).toEqual([300, 1000]);
    await expect(api.refresh()).rejects.toMatchObject({
      code: "refresh_superseded",
    });
    expect(requests).toHaveLength(6);
  });

  it("stops retrying refresh_superseded after 20 s", async () => {
    let now = 0;
    const { fetch, requests } = scriptedFetch(
      () => {
        now += 19_900;
        return problem(409, "refresh_superseded");
      },
      () => tokenResponse(TOKEN_A),
    );
    const { api } = client(fetch, { now: () => now });
    await expect(api.refresh()).rejects.toMatchObject({
      code: "refresh_superseded",
    });
    expect(requests).toHaveLength(1);
  });

  it("lets the coordinator hand over a token from another tab", async () => {
    const refresh = vi.fn((stale: string | undefined) => {
      expect(stale).toBe(TOKEN_A);
      return Promise.resolve({ token: TOKEN_B, expiresAt: 2_000_000 });
    });
    const coordinator: RefreshCoordinator = { refresh };
    const { fetch, requests } = scriptedFetch(
      () => problem(401, "session_invalid"),
      () => json(200, MY_SESSIONS),
    );
    const { api } = client(fetch, { coordinator });
    api.setAccessToken({ token: TOKEN_A, expiresAt: 2_000_000 });
    await api.sessions();
    expect(requests[1]?.headers.authorization).toBe(`Bearer ${TOKEN_B}`);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("logs out with the token and treats a dead session as logged out", async () => {
    const { fetch, requests } = scriptedFetch(
      () => json(204, null),
      () => tokenResponse(TOKEN_B),
      () => problem(401, "session_invalid"),
      () => problem(401, "session_invalid"),
    );
    const { api } = client(fetch);
    api.setAccessToken({ token: TOKEN_A, expiresAt: 2_000_000 });
    await api.logout();
    expect(requests[0]).toMatchObject({ credentials: "include" });
    expect(api.hasAccessToken).toBe(false);
    await expect(api.logout()).resolves.toBeUndefined();
  });

  it("recognises the second-factor answer and sends reauth headers", async () => {
    const { fetch, requests } = scriptedFetch(
      () =>
        json(200, {
          status: "second_factor_required",
          challenge_token: TOKEN_B,
          methods: ["totp"],
          expires_in: 300,
        }),
      () => json(200, { reauth_token: TOKEN_C, expires_in: 300 }),
      () => json(204, null),
      () => json(204, null),
      () => json(200, { revision: 4 }),
      () => json(204, null),
    );
    const { api } = client(fetch);
    expect(
      await api.login({
        email: "a@example.com",
        auth_key: TOKEN_A,
        device: { name: "x", client_type: "web" },
      }),
    ).toEqual({
      kind: "second_factor",
      challenge: { token: TOKEN_B, methods: ["totp"], expiresIn: 300 },
    });
    expect(api.hasAccessToken).toBe(false);
    api.setAccessToken({ token: TOKEN_A, expiresAt: 2_000_000 });
    expect(await api.reauth(TOKEN_B)).toBe(TOKEN_C);
    await api.putPassword(TOKEN_C, "{}");
    await api.putRecovery(TOKEN_C, "{}");
    expect(await api.putUserData(3, "AQ")).toBe(4);
    await api.revokeSession(SESSION);
    expect(requests[2]?.headers["x-keeman-reauth"]).toBe(TOKEN_C);
    expect(requests[3]?.headers["x-keeman-reauth"]).toBe(TOKEN_C);
    expect(requests[5]).toMatchObject({ method: "DELETE" });
    expect(requests[5]?.url).toBe(
      `http://localhost:18787/v1/me/sessions/${SESSION}`,
    );
  });
});

describe("ApiClient vaults and sync", () => {
  const VAULT = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6d";
  const KEY = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6e";
  const summary = {
    vault_id: VAULT,
    role: "owner",
    state: "active",
    vault_key_version: 1,
    member_key_version: 1,
    key_wrapped: "A".repeat(98),
    pending_key: null,
    invitation: null,
    revision: 3,
    rotation_required: false,
    member_count: 1,
    created: "2026-10-23T08:00:00.000Z",
  };

  async function loggedIn(...handlers: Parameters<typeof scriptedFetch>) {
    const script = scriptedFetch(() => sessionResponse(), ...handlers);
    const { api, sleeps } = client(script.fetch);
    await api.login({
      email: "a@example.com",
      auth_key: TOKEN_B,
      device: { name: "x", client_type: "web" },
    });
    return { api, sleeps, requests: script.requests };
  }

  it("lists vaults and reads change pages", async () => {
    const page = {
      vault_revision: 3,
      key_version: 1,
      objects: [
        {
          id: VAULT,
          type: "vault_meta",
          revision: 1,
          key_version: 1,
          deleted: false,
          data: "AQID",
          updated_at: "2026-10-23T08:00:00.000Z",
          updated_by: USER,
        },
      ],
      next_cursor: "abc",
    };
    const { api, requests } = await loggedIn(
      () => json(200, { vaults: [summary] }),
      () => json(200, page),
      () => json(200, { ...page, objects: [], next_cursor: null }),
    );
    expect(await api.vaults()).toEqual([summary]);
    expect(await api.changes(VAULT, 0)).toEqual(page);
    await api.changes(VAULT, 2, "abc", 100);
    expect(requests[2]?.url).toBe(`${BASE}v1/vaults/${VAULT}/changes?since=0`);
    expect(requests[3]?.url).toBe(
      `${BASE}v1/vaults/${VAULT}/changes?since=2&cursor=abc&limit=100`,
    );
  });

  it("retries idempotent writes with the same key and body", async () => {
    const result = { vault_revision: 4, results: [{ id: VAULT, revision: 4 }] };
    const { api, sleeps, requests } = await loggedIn(
      () => {
        throw new TypeError("offline");
      },
      () => problem(503, "internal_error"),
      () => json(200, result),
      () => problem(408, "request_timeout"),
      () => json(201, { revision: 1 }),
    );
    expect(await api.batch(VAULT, KEY, '{"ops":[]}')).toEqual(result);
    expect(sleeps).toEqual([300, 1000]);
    const batches = requests.slice(1, 4);
    expect(batches.map((r) => r.headers["idempotency-key"])).toEqual([
      KEY,
      KEY,
      KEY,
    ]);
    expect(new Set(batches.map((r) => r.body))).toEqual(
      new Set(['{"ops":[]}']),
    );
    expect(await api.createVault(KEY, "{}")).toBe(1);
    expect(requests[5]?.headers["idempotency-key"]).toBe(KEY);
  });

  it("does not retry other errors of writes and parses conflicts", async () => {
    const { api } = await loggedIn(
      () =>
        problem(409, "conflict", {
          conflicts: [{ id: VAULT, current_revision: null, deleted: false }],
        }),
      () => problem(409, "stale_key_version", { current_key_version: 2 }),
      () => problem(409, "conflict", { conflicts: "nonsense" }),
    );
    const conflict = await api.batch(VAULT, KEY, "{}").catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ApiError);
    expect((conflict as ApiError).details.conflicts).toEqual([
      { id: VAULT, currentRevision: null, deleted: false },
    ]);
    const stale = await api.batch(VAULT, KEY, "{}").catch((e: unknown) => e);
    expect((stale as ApiError).details.currentKeyVersion).toBe(2);
    const broken = await api.batch(VAULT, KEY, "{}").catch((e: unknown) => e);
    expect((broken as ApiError).details.conflicts).toBeUndefined();
  });

  it("deletes vaults and the account with reauth, the latter with the cookie", async () => {
    const { api, requests } = await loggedIn(
      () => json(204, null),
      () => json(204, null),
    );
    await api.deleteVault(VAULT, TOKEN_C);
    expect(requests[1]?.method).toBe("DELETE");
    expect(requests[1]?.headers["x-keeman-reauth"]).toBe(TOKEN_C);
    expect(requests[1]?.credentials).toBe("omit");
    await api.deleteMe(TOKEN_C);
    expect(requests[2]?.url).toBe(`${BASE}v1/me`);
    expect(requests[2]?.credentials).toBe("include");
    expect(api.hasAccessToken).toBe(false);
  });

  it("hands out a valid token for the WebSocket and its URL", async () => {
    let now = 1_000_000;
    const script = scriptedFetch(
      () => sessionResponse(),
      () => tokenResponse(TOKEN_C),
    );
    const { api } = client(script.fetch, { now: () => now });
    await api.login({
      email: "a@example.com",
      auth_key: TOKEN_B,
      device: { name: "x", client_type: "web" },
    });
    expect(await api.socketToken()).toBe(TOKEN_A);
    now += 900_000;
    expect(await api.socketToken()).toBe(TOKEN_C);
    expect(api.eventsUrl).toBe("ws://localhost:18787/v1/events");
    const secure = new ApiClient({
      baseUrl: "https://api.example.org",
      clientId: "web/0.1.0",
    });
    expect(secure.eventsUrl).toBe("wss://api.example.org/v1/events");
  });
});

describe("ApiClient attachments", () => {
  const VAULT = "0192b3a4-5c6d-7e8f-9a0b-000000000001";
  const ID = "0192b3a4-5c6d-7e8f-9a0b-000000000002";
  const ENTRY = "0192b3a4-5c6d-7e8f-9a0b-000000000003";

  /** Answers the refresh, then `handle` for every other request. */
  function binaryFetch(
    handle: (url: string, init: RequestInit) => Response | Promise<Response>,
  ) {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.endsWith("/v1/auth/refresh")) return tokenResponse(TOKEN_A);
        seen.push({ url, init });
        return handle(url, init);
      },
    ) as unknown as typeof globalThis.fetch;
    return { fetch, seen };
  }

  it("sends parts as octet-stream and reads blobs with progress", async () => {
    const blob = Uint8Array.from({ length: 300_000 }, (_, i) => i % 251);
    const { fetch, seen } = binaryFetch((url, init) => {
      if (init.method === "PUT") return new Response(null, { status: 204 });
      if (url.endsWith("/attachments"))
        return json(201, { part_size: 8_388_608, parts: 1 });
      return new Response(blob, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    });
    const { api } = client(fetch);
    expect(await api.createAttachment(VAULT, ID, ENTRY, 300_042)).toEqual({
      part_size: 8_388_608,
      parts: 1,
    });
    await api.putAttachmentPart(VAULT, ID, 0, blob);
    const progress: (number | undefined)[] = [];
    const back = await api.downloadAttachment(VAULT, ID, {
      onProgress: (received) => progress.push(received),
    });
    expect(back).toEqual(blob);
    expect(progress.at(-1)).toBe(300_000);
    const [create, part, download] = seen;
    expect(JSON.parse(create?.init.body as string)).toEqual({
      attachment_id: ID,
      entry_id: ENTRY,
      size: 300_042,
    });
    const headers = new Headers(part?.init.headers);
    expect(part?.url).toMatch(
      new RegExp(`/v1/vaults/${VAULT}/attachments/${ID}/parts/0$`),
    );
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(part?.init.body).toBe(blob);
    expect(new Headers(download?.init.headers).get("accept")).toBe(
      "application/octet-stream",
    );
  });

  it("treats repeats as done and does not retry a full quota", async () => {
    const answers = [
      problem(409, "conflict"),
      problem(404, "not_found"),
      problem(507, "quota_exceeded"),
      problem(503, "internal_error"),
      new Response(null, { status: 204 }),
    ];
    const { fetch, seen } = binaryFetch(() => answers.shift() ?? json(500, {}));
    const { api, sleeps } = client(fetch);
    // A lost create answered: the fresh ID is ours.
    expect(await api.createAttachment(VAULT, ID, ENTRY, 8_388_609)).toEqual({
      part_size: 8_388_608,
      parts: 2,
    });
    await api.deleteAttachment(VAULT, ID);
    await expect(
      api.transferAttachment(VAULT, ID, VAULT, ENTRY),
    ).rejects.toMatchObject({
      code: "quota_exceeded",
    });
    expect(sleeps).toEqual([]);
    await api.completeAttachment(VAULT, ID);
    expect(sleeps).toEqual([300]);
    expect(seen.map((s) => s.init.method)).toEqual([
      "POST",
      "DELETE",
      "POST",
      "POST",
      "POST",
    ]);
  });

  it("passes an abort through unchanged and never retries it", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped by the user");
    const { fetch, seen } = binaryFetch((_url, init) => {
      controller.abort(reason);
      return Promise.reject(init.signal?.reason as Error);
    });
    const { api } = client(fetch);
    await expect(
      api.putAttachmentPart(VAULT, ID, 0, new Uint8Array(1), controller.signal),
    ).rejects.toBe(reason);
    expect(seen).toHaveLength(1);
    await expect(
      api.downloadAttachment(VAULT, ID, { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});

describe("ApiClient sharing", () => {
  const VAULT = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6d";
  const OTHER = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a70";
  const ROTATION = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a71";
  const KEY = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6e";
  const user = { user_id: OTHER, email: "b@example.com", public_key: TOKEN_C };
  const member = {
    ...user,
    role: "member",
    state: "pending",
    invited_by: USER,
    created: "2026-10-23T08:00:00.000Z",
  };
  const grant = { key_version: 1, key_wrapped: "A".repeat(98) };

  async function loggedIn(...handlers: Parameters<typeof scriptedFetch>) {
    const script = scriptedFetch(() => sessionResponse(), ...handlers);
    const { api, sleeps } = client(script.fetch);
    await api.login({
      email: "a@example.com",
      auth_key: TOKEN_B,
      device: { name: "x", client_type: "web" },
    });
    return { api, sleeps, requests: script.requests };
  }

  it("looks up accounts and public keys and lists members", async () => {
    const { api, requests } = await loggedIn(
      () => problem(503, "internal_error"),
      () => json(200, user),
      () => json(200, user),
      () => json(200, { members: [member] }),
    );
    expect(await api.lookupUser("b@example.com")).toEqual(user);
    expect(requests[2]?.body).toBe('{"email":"b@example.com"}');
    expect(await api.publicKey(OTHER)).toEqual(user);
    expect(requests[3]?.url).toBe(`${BASE}v1/users/${OTHER}/public-key`);
    expect(await api.members(VAULT)).toEqual([member]);
    expect(requests[4]?.url).toBe(`${BASE}v1/vaults/${VAULT}/members`);
  });

  it("does not retry invitations, accepts or leaving", async () => {
    const { api, requests } = await loggedIn(
      () => problem(503, "internal_error"),
      () => problem(503, "internal_error"),
      () => problem(503, "internal_error"),
    );
    const invite = { user_id: OTHER, key_version: 1, key_box: "Ag" };
    await expect(api.inviteMember(VAULT, invite)).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(api.acceptInvitation(VAULT, grant)).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(api.leaveVault(VAULT)).rejects.toBeInstanceOf(ApiError);
    expect(requests.slice(1).map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST ${BASE}v1/vaults/${VAULT}/members`,
      `POST ${BASE}v1/vaults/${VAULT}/accept`,
      `DELETE ${BASE}v1/vaults/${VAULT}/members/me`,
    ]);
  });

  it("changes roles with PATCH and sends the other member calls", async () => {
    const empty = () => new Response(null, { status: 204 });
    const { api, requests } = await loggedIn(
      () => problem(503, "internal_error"),
      empty,
      empty,
      empty,
      empty,
      empty,
    );
    await api.updateMember(VAULT, OTHER, "owner");
    await api.withdrawInvitation(VAULT, OTHER);
    await api.declineInvitation(VAULT);
    await api.acceptVaultKey(VAULT, grant);
    await api.inviteMember(VAULT, {
      user_id: OTHER,
      key_version: 1,
      key_box: "Ag",
    });
    expect(requests.slice(1).map((r) => `${r.method} ${r.url}`)).toEqual([
      `PATCH ${BASE}v1/vaults/${VAULT}/members/${OTHER}`,
      `PATCH ${BASE}v1/vaults/${VAULT}/members/${OTHER}`,
      `DELETE ${BASE}v1/vaults/${VAULT}/members/${OTHER}`,
      `POST ${BASE}v1/vaults/${VAULT}/decline`,
      `POST ${BASE}v1/vaults/${VAULT}/key`,
      `POST ${BASE}v1/vaults/${VAULT}/members`,
    ]);
    expect(requests[1]?.body).toBe('{"role":"owner"}');
    expect(requests[5]?.body).toBe(JSON.stringify(grant));
  });

  it("runs a rotation with idempotency keys and the same bytes", async () => {
    const { api, sleeps, requests } = await loggedIn(
      () => json(201, { rotation_id: ROTATION, expires_in: 3600 }),
      () => {
        throw new TypeError("offline");
      },
      () => new Response(null, { status: 204 }),
      () => json(200, { revision: 9 }),
    );
    const opened = await api.openRotation(VAULT, KEY, '{"base_revision":8}');
    expect(opened).toEqual({ rotation_id: ROTATION, expires_in: 3600 });
    await api.uploadRotationObjects(VAULT, ROTATION, KEY, '{"objects":[]}');
    expect(await api.commitRotation(VAULT, ROTATION, KEY, "{}")).toBe(9);
    expect(sleeps).toEqual([300]);
    const base = `${BASE}v1/vaults/${VAULT}/rotations`;
    expect(requests.slice(1).map((r) => `${r.method} ${r.url}`)).toEqual([
      `POST ${base}`,
      `PUT ${base}/${ROTATION}/objects`,
      `PUT ${base}/${ROTATION}/objects`,
      `POST ${base}/${ROTATION}/commit`,
    ]);
    expect(requests[2]?.body).toBe(requests[3]?.body);
    expect(
      requests.slice(1).every((r) => r.headers["idempotency-key"] === KEY),
    ).toBe(true);
  });
});

describe("second factor, recovery and own 2FA", () => {
  const WRAPPED = `AQ${"A".repeat(96)}`;
  const recoveryPayload = (extra: object = {}) =>
    json(200, {
      status: "recovery_ok",
      recovery_token: TOKEN_C,
      user_id: USER,
      user_key_recovery_wrapped: WRAPPED,
      expires_in: 600,
      ...extra,
    });
  const CODES = Array.from(
    { length: 10 },
    (_, i) => `ABCDEFGHI${"234567AB"[i % 8] ?? "A"}`,
  );

  it("completes challenges with a session or a recovery payload", async () => {
    const { fetch, requests } = scriptedFetch(
      () =>
        json(200, {
          status: "ok",
          session_id: SESSION,
          user_id: USER,
          access_token: TOKEN_A,
          access_expires_in: 900,
          backup_codes_remaining: 3,
        }),
      () => recoveryPayload(),
      () =>
        json(200, {
          public_key: { challenge: "abc", rpId: "app.example.org" },
        }),
      () => sessionResponse(TOKEN_B),
    );
    const { api } = client(fetch);
    expect(await api.secondFactorBackupCode(TOKEN_B, "AAAAA-AAAAA")).toEqual({
      kind: "session",
      sessionId: SESSION,
      userId: USER,
      backupCodesRemaining: 3,
    });
    expect(api.hasAccessToken).toBe(true);
    expect(await api.secondFactorTotp(TOKEN_B, "123456")).toEqual({
      kind: "recovery",
      payload: {
        recoveryToken: TOKEN_C,
        userId: USER,
        userKeyRecoveryWrapped: WRAPPED,
        expiresIn: 600,
      },
      backupCodesRemaining: undefined,
    });
    expect(await api.secondFactorWebauthnOptions(TOKEN_B)).toEqual({
      challenge: "abc",
      rpId: "app.example.org",
    });
    const credential = { id: "x", response: { signature: "y" } };
    const outcome = await api.secondFactorWebauthn(TOKEN_B, credential);
    expect(outcome.kind).toBe("session");
    expect(requests.map((r) => r.url)).toEqual([
      `${BASE}v1/auth/2fa/backup-code`,
      `${BASE}v1/auth/2fa/totp`,
      `${BASE}v1/auth/2fa/webauthn/options`,
      `${BASE}v1/auth/2fa/webauthn/verify`,
    ]);
    // Every 2fa/* call sends and stores the cookie.
    for (const request of requests) expect(request.credentials).toBe("include");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      challenge_token: TOKEN_B,
      code: "AAAAA-AAAAA",
    });
    expect(JSON.parse(requests[3]?.body ?? "")).toEqual({
      challenge_token: TOKEN_B,
      credential,
    });
  });

  it("never retries a second factor and rejects malformed answers", async () => {
    const { fetch, requests } = scriptedFetch(
      () => problem(500, "internal_error"),
      () => json(200, { status: "ok" }),
      () => problem(401, "invalid_second_factor"),
    );
    const { api, sleeps } = client(fetch);
    await expect(api.secondFactorTotp(TOKEN_B, "123456")).rejects.toMatchObject(
      {
        status: 500,
      },
    );
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
    await expect(api.secondFactorTotp(TOKEN_B, "123456")).rejects.toEqual(
      new NetworkError("response"),
    );
    const error: unknown = await api
      .secondFactorTotp(TOKEN_B, "123456")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_second_factor");
  });

  it("starts and finishes a recovery", async () => {
    const { fetch, requests } = scriptedFetch(
      () => recoveryPayload(),
      () =>
        json(200, {
          status: "second_factor_required",
          challenge_token: TOKEN_A,
          methods: ["webauthn", "backup_code"],
          expires_in: 300,
        }),
      () => sessionResponse(TOKEN_B),
    );
    const { api } = client(fetch);
    const started = await api.recoverStart("a@example.com", TOKEN_A);
    expect(started).toEqual({
      kind: "recovery",
      payload: {
        recoveryToken: TOKEN_C,
        userId: USER,
        userKeyRecoveryWrapped: WRAPPED,
        expiresIn: 600,
      },
    });
    expect(await api.recoverStart("a@example.com", TOKEN_A)).toEqual({
      kind: "second_factor",
      challenge: {
        token: TOKEN_A,
        methods: ["webauthn", "backup_code"],
        expiresIn: 300,
      },
    });
    expect(await api.recoverFinish('{"x":1}')).toEqual({
      sessionId: SESSION,
      userId: USER,
    });
    expect(api.hasAccessToken).toBe(true);
    expect(requests[0]?.credentials).toBe("omit");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      email: "a@example.com",
      recovery_auth_key: TOKEN_A,
    });
    expect(requests[2]?.credentials).toBe("include");
    expect(requests[2]?.body).toBe('{"x":1}');
  });

  it("manages TOTP, backup codes and passkeys with reauth tokens", async () => {
    const secret = "A".repeat(32);
    const { fetch, requests } = scriptedFetch(
      () =>
        json(200, {
          secret,
          otpauth_uri: `otpauth://totp/KeeMan:a%40example.com?secret=${secret}&issuer=KeeMan`,
        }),
      () => json(200, { backup_codes: CODES }),
      () => json(200, {}),
      () => json(204, null),
      () => json(200, { backup_codes: CODES }),
      () =>
        json(200, {
          registration_token: TOKEN_B,
          public_key: { challenge: "c", user: { id: "u" } },
        }),
      () => json(201, { id: SESSION }),
      () =>
        json(200, {
          credentials: [
            {
              id: SESSION,
              name: "Laptop",
              created: "2026-10-23T08:00:00.000Z",
              last_used: null,
              prf_enabled: false,
            },
          ],
        }),
      () => json(204, null),
    );
    const { api } = client(fetch);
    api.setAccessToken({ token: TOKEN_A, expiresAt: 2_000_000 });
    expect(await api.totpSetup(TOKEN_C)).toEqual({
      secret,
      otpauthUri: `otpauth://totp/KeeMan:a%40example.com?secret=${secret}&issuer=KeeMan`,
    });
    expect(await api.totpEnable("123456")).toEqual(CODES);
    expect(await api.totpEnable("123456")).toBeUndefined();
    await api.totpDisable(TOKEN_C);
    expect(await api.regenerateBackupCodes(TOKEN_C)).toEqual(CODES);
    expect(await api.webauthnRegisterOptions(TOKEN_C, "Laptop")).toEqual({
      registrationToken: TOKEN_B,
      publicKey: { challenge: "c", user: { id: "u" } },
    });
    expect(await api.webauthnRegisterVerify(TOKEN_B, { id: "x" })).toEqual({
      id: SESSION,
      backupCodes: undefined,
    });
    expect((await api.passkeys())[0]?.name).toBe("Laptop");
    await api.deletePasskey(TOKEN_C, SESSION);
    const reauthed = [0, 3, 4, 5, 8];
    for (const index of reauthed)
      expect(requests[index]?.headers["x-keeman-reauth"]).toBe(TOKEN_C);
    for (const request of requests) expect(request.credentials).toBe("omit");
    expect(
      requests.map((r) => `${r.method} ${r.url.slice(BASE.length - 1)}`),
    ).toEqual([
      "POST /v1/me/totp/setup",
      "POST /v1/me/totp/enable",
      "POST /v1/me/totp/enable",
      "DELETE /v1/me/totp",
      "POST /v1/me/backup-codes",
      "POST /v1/me/webauthn/register/options",
      "POST /v1/me/webauthn/register/verify",
      "GET /v1/me/webauthn",
      `DELETE /v1/me/webauthn/${SESSION}`,
    ]);
  });
});

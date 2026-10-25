import { vi } from "vitest";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  credentials: RequestCredentials | undefined;
  redirect: RequestRedirect | undefined;
}

type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function problem(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      title: "x",
      status,
      code,
      instance: "urn:uuid:0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6b",
      ...extra,
    }),
    {
      status,
      headers: { "content-type": "application/problem+json", ...headers },
    },
  );
}

/** A fetch that records requests and answers from a queue of handlers. */
export function scriptedFetch(...handlers: Handler[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...handlers];
  const fetch = vi.fn(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const request: RecordedRequest = {
        method: init.method ?? "GET",
        url:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        headers,
        body: typeof init.body === "string" ? init.body : undefined,
        credentials: init.credentials,
        redirect: init.redirect,
      };
      requests.push(request);
      const handler = queue.shift();
      if (!handler)
        throw new Error(`unexpected request ${request.method} ${request.url}`);
      return handler(request);
    },
  );
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    requests,
    pending: () => queue.length,
  };
}

export const TOKEN_A = "A".repeat(43);
export const TOKEN_B = "B".repeat(43);
export const TOKEN_C = "C".repeat(43);

export function tokenResponse(token: string, expiresIn = 900): Response {
  return json(200, { access_token: token, access_expires_in: expiresIn });
}

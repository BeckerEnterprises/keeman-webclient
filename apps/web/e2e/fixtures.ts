/**
 * Every test checks: no CSP violations, requests only to
 * the web client and the API, and at the end only the allowed
 * localStorage keys without secrets, nothing in other storages.
 */
import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { ALLOWED_HOSTS } from "./env";

const ALLOWED_STORAGE_KEYS = [
  "keeman.theme",
  "keeman.locale",
  "keeman.kdfSeen",
  "keeman.syncSeen",
  "keeman.view",
];

interface Guard {
  /** Values that must never appear in browser storage. */
  secrets: string[];
}

declare global {
  interface Window {
    __keemanCspViolation?: (text: string) => Promise<void>;
  }
}

/**
 * Watches a browser context; the returned check runs at the end of the
 * test, for the default context and every further one.
 */
async function watchContext(
  context: BrowserContext,
  guard: Guard,
): Promise<() => Promise<void>> {
  const foreign: string[] = [];
  // Violations go straight to the test, so reloaded and closed pages count too.
  const violations: string[] = [];
  await context.exposeBinding("__keemanCspViolation", (_source, text) => {
    violations.push(String(text));
  });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void window.__keemanCspViolation?.(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  // WebSockets are no requests in Playwright; they are checked per page.
  const watch = (page: Page) => {
    page.on("websocket", (socket) => {
      const url = new URL(socket.url());
      if (!ALLOWED_HOSTS.includes(url.host)) foreign.push(url.href);
    });
  };
  context.pages().forEach(watch);
  context.on("page", watch);
  context.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" ||
        url.protocol === "https:" ||
        url.protocol === "ws:") &&
      !ALLOWED_HOSTS.includes(url.host)
    )
      foreign.push(url.href);
  });
  context.on("response", (response) => {
    // Tokens seen on the wire must not end up in storage either.
    void response
      .json()
      .then((body: unknown) => {
        if (typeof body !== "object" || body === null) return;
        const record = body as Record<string, unknown>;
        for (const key of [
          "access_token",
          "refresh_token",
          "reauth_token",
          "challenge_token",
          "recovery_token",
          "registration_token",
          "secret",
        ]) {
          const value = record[key];
          if (typeof value === "string") guard.secrets.push(value);
        }
        // Backup codes are secrets too.
        if (Array.isArray(record.backup_codes))
          for (const code of record.backup_codes)
            if (typeof code === "string") guard.secrets.push(code);
      })
      .catch(() => undefined);
  });
  return async () => {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const state = await page
        .evaluate(async () => {
          const local: Record<string, string> = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key !== null) local[key] = localStorage.getItem(key) ?? "";
          }
          const databases =
            "databases" in indexedDB ? await indexedDB.databases() : [];
          return {
            local,
            session: sessionStorage.length,
            databases: databases.map((db) => db.name),
            caches: await caches.keys(),
            workers: (await navigator.serviceWorker.getRegistrations()).length,
          };
        })
        .catch(() => undefined);
      if (!state) continue;
      for (const key of Object.keys(state.local))
        expect(ALLOWED_STORAGE_KEYS, `localStorage key ${key}`).toContain(key);
      const stored = Object.values(state.local).join("\n");
      for (const secret of guard.secrets.filter((s) => s.length >= 8))
        expect(stored.includes(secret), "secret in localStorage").toBe(false);
      expect(state.session, "sessionStorage").toBe(0);
      expect(state.databases, "IndexedDB").toEqual([]);
      expect(state.caches, "Cache Storage").toEqual([]);
      expect(state.workers, "service workers").toBe(0);
    }
    expect(violations, "CSP violations").toEqual([]);
    expect(foreign, "requests to other hosts").toEqual([]);
  };
}

export const test = base.extend<{ guard: Guard; otherContext: BrowserContext }>(
  {
    guard: [
      async ({ context }, use) => {
        const guard: Guard = { secrets: [] };
        const check = await watchContext(context, guard);
        await use(guard);
        await check();
      },
      { auto: true },
    ],
    /** A second browser (another account), checked like the first. */
    otherContext: async ({ browser, guard }, use) => {
      const context = await browser.newContext({ locale: "de-DE" });
      const check = await watchContext(context, guard);
      await use(context);
      await check();
      await context.close();
    },
  },
);

export { expect };

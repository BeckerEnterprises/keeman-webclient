/**
 * Coordination between tabs of this browser profile: one refresh
 * at a time via Web Locks, new access tokens, lock, logout and sign-in
 * events via a BroadcastChannel. Keys never cross tabs.
 */
import type { AccessToken, RefreshCoordinator } from "@keeman/core";

const CHANNEL = "keeman";
const LOCK = "keeman-refresh";
const LOCK_TIMEOUT_MS = 10_000;

export type TabMessage =
  | { type: "token"; token: string; expiresAt: number }
  | { type: "lock" }
  | { type: "logout" }
  | { type: "session"; userId: string };

export interface TabHandlers {
  token(token: AccessToken): void;
  lock(): void;
  logout(): void;
  session(userId: string): void;
}

function parseMessage(data: unknown): TabMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const message = data as Record<string, unknown>;
  switch (message.type) {
    case "token":
      return typeof message.token === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(message.token) &&
        typeof message.expiresAt === "number"
        ? { type: "token", token: message.token, expiresAt: message.expiresAt }
        : undefined;
    case "lock":
    case "logout":
      return { type: message.type };
    case "session":
      return typeof message.userId === "string"
        ? { type: "session", userId: message.userId }
        : undefined;
    default:
      return undefined;
  }
}

export class TabSync implements RefreshCoordinator {
  readonly #channel: BroadcastChannel | undefined;
  #latest: AccessToken | undefined;
  #handlers: TabHandlers | undefined;

  constructor() {
    this.#channel =
      typeof BroadcastChannel === "undefined"
        ? undefined
        : new BroadcastChannel(CHANNEL);
    this.#channel?.addEventListener("message", (event: MessageEvent) => {
      this.#receive(event.data);
    });
  }

  listen(handlers: TabHandlers): void {
    this.#handlers = handlers;
  }

  send(message: Exclude<TabMessage, { type: "token" }>): void {
    this.#channel?.postMessage(message);
  }

  async refresh(
    stale: string | undefined,
    perform: () => Promise<AccessToken>,
  ): Promise<AccessToken> {
    // Typed as always present, but missing in old browsers and some test setups.
    const locks = (navigator as Partial<Pick<Navigator, "locks">>).locks;
    if (!locks) return this.#performAndShare(perform);
    try {
      return await locks.request(
        LOCK,
        { signal: AbortSignal.timeout(LOCK_TIMEOUT_MS) },
        async () => {
          const latest = this.#latest;
          if (latest && latest.token !== stale && latest.expiresAt > Date.now())
            return latest;
          return this.#performAndShare(perform);
        },
      );
    } catch (error) {
      // A frozen tab may hold the lock; continue without it (the server
      // answers 409 refresh_superseded within 30 s instead of revoking).
      if (error instanceof DOMException && error.name === "TimeoutError")
        return this.#performAndShare(perform);
      throw error;
    }
  }

  async #performAndShare(
    perform: () => Promise<AccessToken>,
  ): Promise<AccessToken> {
    const token = await perform();
    this.#latest = token;
    this.#channel?.postMessage({
      type: "token",
      token: token.token,
      expiresAt: token.expiresAt,
    } satisfies TabMessage);
    return token;
  }

  #receive(data: unknown): void {
    const message = parseMessage(data);
    if (!message || !this.#handlers) return;
    switch (message.type) {
      case "token":
        this.#latest = { token: message.token, expiresAt: message.expiresAt };
        this.#handlers.token(this.#latest);
        break;
      case "lock":
        this.#handlers.lock();
        break;
      case "logout":
        this.#latest = undefined;
        this.#handlers.logout();
        break;
      case "session":
        this.#handlers.session(message.userId);
        break;
    }
  }
}

/**
 * Client of `GET /v1/events`: auth message, events as
 * hints, reconnect with backoff, one refresh after `4401`.
 */
import { ApiError } from "../api/errors";
import { systemRandomness } from "../crypto/random";
import { isUuid } from "../crypto/uuid";

/** A WebSocket as the core needs it; the app adapts the browser's. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  onOpen(listener: () => void): void;
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: (code: number) => void): void;
}

export type SocketFactory = (url: string) => SocketLike;

export type ServerEvent =
  | { type: "vault_changed"; vaultId: string; revision: number }
  | { type: "vaults_changed" }
  | { type: "user_data_changed"; revision: number }
  | { type: "confirmations_changed" };

export type ConnectionState = "offline" | "connecting" | "online";

export interface Timers {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemTimers: Timers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface EventClientOptions {
  url: string;
  socket: SocketFactory;
  /** A valid access token (refreshed if expired). */
  token(): Promise<string>;
  /** Refresh after `4401`; `false`: the session is gone. */
  refresh(): Promise<boolean>;
  onReady(): void;
  onEvent(event: ServerEvent): void;
  onState(state: ConnectionState): void;
  /** Revoked or invalid session: lock and log out. */
  onSessionEnded(): void;
  timers?: Timers;
  /** A number in [0, 1) for the backoff jitter; tests may fix it. */
  jitter?: () => number;
}

const MAX_DELAY_MS = 60_000;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_TOO_MANY = 4429;

function defaultJitter(): number {
  const [a = 0, b = 0] = systemRandomness.bytes("jitter", 2);
  return (a * 256 + b) / 65_536;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Known server messages; anything else is ignored. */
export function parseServerMessage(
  data: unknown,
): ServerEvent | "ready" | "session_revoked" | undefined {
  if (typeof data !== "string") return undefined;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null) return undefined;
  const m = message as Record<string, unknown>;
  switch (m.type) {
    case "ready":
    case "session_revoked":
      return m.type;
    case "vaults_changed":
      return { type: "vaults_changed" };
    case "confirmations_changed":
      return { type: "confirmations_changed" };
    case "vault_changed":
      return isUuid(m.vault_id) && positiveInteger(m.revision)
        ? { type: "vault_changed", vaultId: m.vault_id, revision: m.revision }
        : undefined;
    case "user_data_changed":
      return positiveInteger(m.revision)
        ? { type: "user_data_changed", revision: m.revision }
        : undefined;
    default:
      return undefined;
  }
}

export class EventClient {
  readonly #options: EventClientOptions;
  readonly #timers: Timers;
  readonly #jitter: () => number;
  #socket: SocketLike | undefined;
  #timer: unknown;
  #attempt = 0;
  #refreshed = false;
  #stopped = true;
  #state: ConnectionState = "offline";

  constructor(options: EventClientOptions) {
    this.#options = options;
    this.#timers = options.timers ?? systemTimers;
    this.#jitter = options.jitter ?? defaultJitter;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
    const socket = this.#socket;
    this.#socket = undefined;
    socket?.close(1000);
    this.#setState("offline");
  }

  /** Online again or tab visible: connect now instead of waiting. */
  nudge(): void {
    if (this.#stopped || this.#socket) return;
    this.#clearTimer();
    this.#connect();
  }

  #setState(state: ConnectionState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#options.onState(state);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #end(): void {
    this.stop();
    this.#options.onSessionEnded();
  }

  #connect(): void {
    this.#setState("connecting");
    const socket = this.#options.socket(this.#options.url);
    this.#socket = socket;
    const current = () => this.#socket === socket && !this.#stopped;
    socket.onOpen(() => {
      void this.#options.token().then(
        (token) => {
          if (current())
            socket.send(JSON.stringify({ type: "auth", access_token: token }));
        },
        (error: unknown) => {
          if (!current()) return;
          if (error instanceof ApiError && error.status === 401) this.#end();
          else socket.close(1000);
        },
      );
    });
    socket.onMessage((data) => {
      if (!current()) return;
      const message = parseServerMessage(data);
      if (message === "ready") {
        this.#attempt = 0;
        this.#refreshed = false;
        this.#setState("online");
        this.#options.onReady();
      } else if (message === "session_revoked") {
        this.#end();
      } else if (message) {
        this.#options.onEvent(message);
      }
    });
    socket.onClose((code) => {
      if (!current()) return;
      this.#socket = undefined;
      this.#setState("offline");
      void this.#closed(code);
    });
  }

  async #closed(code: number): Promise<void> {
    if (code === CLOSE_UNAUTHORIZED) {
      if (this.#refreshed) {
        this.#end();
        return;
      }
      this.#refreshed = true;
      const ok = await this.#options.refresh().catch(() => false);
      if (this.#stopped) return;
      if (!ok) this.#end();
      else this.#connect();
      return;
    }
    const delay =
      code === CLOSE_TOO_MANY
        ? MAX_DELAY_MS
        : Math.min(MAX_DELAY_MS, 1000 * 2 ** this.#attempt);
    this.#attempt++;
    const jittered = Math.round(delay * (0.8 + 0.4 * this.#jitter()));
    this.#timer = this.#timers.setTimeout(() => {
      this.#timer = undefined;
      if (!this.#stopped && !this.#socket) this.#connect();
    }, jittered);
  }
}

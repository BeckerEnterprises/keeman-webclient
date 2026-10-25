import { describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError } from "../../src/api/errors";
import { FakeSocket } from "./fake-socket";
import {
  EventClient,
  parseServerMessage,
  type EventClientOptions,
  type Timers,
} from "../../src/sync/events";

const VAULT = "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5a6d";

class FakeTimers implements Timers {
  pending: { run: () => void; ms: number; id: number }[] = [];
  #next = 1;
  setTimeout(run: () => void, ms: number) {
    const id = this.#next++;
    this.pending.push({ run, ms, id });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.pending = this.pending.filter((t) => t.id !== handle);
  }
  fire() {
    const timer = this.pending.shift();
    timer?.run();
    return timer?.ms;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(extra: Partial<EventClientOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const timers = new FakeTimers();
  const calls = {
    ready: 0,
    ended: 0,
    events: [] as unknown[],
    states: [] as string[],
  };
  const options: EventClientOptions = {
    url: "ws://localhost/v1/events",
    socket: (url) => {
      expect(url).toBe("ws://localhost/v1/events");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    token: () => Promise.resolve("T".repeat(43)),
    refresh: () => Promise.resolve(true),
    onReady: () => calls.ready++,
    onEvent: (event) => calls.events.push(event),
    onState: (state) => calls.states.push(state),
    onSessionEnded: () => calls.ended++,
    timers,
    jitter: () => 0.5,
    ...extra,
  };
  const client = new EventClient(options);
  const socket = () => sockets.at(-1) ?? new FakeSocket();
  return { client, sockets, socket, timers, calls };
}

describe("server messages", () => {
  it("parses the known messages and ignores everything else", () => {
    expect(parseServerMessage('{"type":"ready"}')).toBe("ready");
    expect(parseServerMessage('{"type":"session_revoked"}')).toBe(
      "session_revoked",
    );
    expect(parseServerMessage('{"type":"vaults_changed","x":1}')).toEqual({
      type: "vaults_changed",
    });
    expect(
      parseServerMessage(
        JSON.stringify({ type: "vault_changed", vault_id: VAULT, revision: 4 }),
      ),
    ).toEqual({ type: "vault_changed", vaultId: VAULT, revision: 4 });
    expect(
      parseServerMessage('{"type":"user_data_changed","revision":2}'),
    ).toEqual({
      type: "user_data_changed",
      revision: 2,
    });
    for (const bad of [
      42,
      "not json",
      "null",
      '{"type":"vault_changed","vault_id":"x","revision":1}',
      '{"type":"user_data_changed","revision":0}',
      '{"type":"later"}',
    ])
      expect(parseServerMessage(bad)).toBeUndefined();
  });
});

describe("event client", () => {
  it("authenticates after open and reports events", async () => {
    const { client, socket, calls } = setup();
    client.start();
    client.start();
    expect(calls.states).toEqual(["connecting"]);
    socket().open();
    await flush();
    expect(JSON.parse(socket().sent[0] ?? "")).toEqual({
      type: "auth",
      access_token: "T".repeat(43),
    });
    socket().message({ type: "ready" });
    expect(calls.ready).toBe(1);
    expect(client.state).toBe("online");
    socket().message({ type: "vaults_changed" });
    socket().message({ type: "unknown" });
    expect(calls.events).toEqual([{ type: "vaults_changed" }]);
    socket().message({ type: "session_revoked" });
    expect(calls.ended).toBe(1);
    expect(client.state).toBe("offline");
    expect(socket().closed).toBe(1000);
  });

  it("reconnects with exponential backoff, the longest after 4429", async () => {
    const { client, socket, sockets, timers } = setup();
    client.start();
    socket().serverClose(1006);
    expect(timers.fire()).toBe(1000);
    socket().serverClose(1011);
    expect(timers.fire()).toBe(2000);
    socket().serverClose(1013);
    expect(timers.fire()).toBe(4000);
    socket().message({ type: "ready" });
    socket().serverClose(1001);
    expect(timers.fire()).toBe(1000);
    socket().serverClose(4429);
    expect(timers.fire()).toBe(60_000);
    for (let i = 0; i < 8; i++) {
      socket().serverClose(1006);
      timers.fire();
    }
    socket().serverClose(1006);
    expect(timers.pending[0]?.ms).toBe(60_000);
    expect(sockets.length).toBeGreaterThan(10);
    await flush();
  });

  it("refreshes once after 4401, then ends the session", async () => {
    const refresh = vi.fn(() => Promise.resolve(true));
    const { client, socket, sockets, calls } = setup({ refresh });
    client.start();
    socket().serverClose(4401);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    socket().serverClose(4401);
    await flush();
    expect(calls.ended).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    const failing = setup({ refresh: () => Promise.resolve(false) });
    failing.client.start();
    failing.socket().serverClose(4401);
    await flush();
    expect(failing.calls.ended).toBe(1);

    const throwing = setup({ refresh: () => Promise.reject(new Error("x")) });
    throwing.client.start();
    throwing.socket().serverClose(4401);
    await flush();
    expect(throwing.calls.ended).toBe(1);
  });

  it("ends the session when no token can be had and closes on other token errors", async () => {
    const ended = setup({
      token: () => Promise.reject(new ApiError(401, "session_invalid")),
    });
    ended.client.start();
    ended.socket().open();
    await flush();
    expect(ended.calls.ended).toBe(1);

    const offline = setup({
      token: () => Promise.reject(new NetworkError("network")),
    });
    offline.client.start();
    offline.socket().open();
    await flush();
    expect(offline.calls.ended).toBe(0);
    expect(offline.socket().closed).toBe(1000);
  });

  it("connects at once on nudge and never after stop", async () => {
    const { client, socket, sockets, timers } = setup();
    client.nudge();
    expect(sockets).toHaveLength(0);
    client.start();
    client.nudge();
    expect(sockets).toHaveLength(1);
    socket().serverClose(1006);
    client.nudge();
    expect(sockets).toHaveLength(2);
    expect(timers.pending).toHaveLength(0);
    const old = socket();
    client.stop();
    old.serverClose(1006);
    old.message({ type: "ready" });
    old.open();
    await flush();
    expect(old.sent).toEqual([]);
    expect(sockets).toHaveLength(2);
    expect(timers.pending).toHaveLength(0);
  });

  it("ignores a 4401 refresh that finishes after stop", async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const { client, socket, sockets } = setup({
      refresh: () => new Promise<boolean>((resolve) => (finish = resolve)),
    });
    client.start();
    socket().serverClose(4401);
    client.stop();
    finish(true);
    await flush();
    expect(sockets).toHaveLength(1);
  });

  it("uses the system timers and jitter by default", () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const client = new EventClient({
        url: "ws://x/v1/events",
        socket: () => {
          const s = new FakeSocket();
          sockets.push(s);
          return s;
        },
        token: () => Promise.resolve("t"),
        refresh: () => Promise.resolve(true),
        onReady: () => undefined,
        onEvent: () => undefined,
        onState: () => undefined,
        onSessionEnded: () => undefined,
      });
      client.start();
      sockets[0]?.serverClose(1006);
      vi.advanceTimersByTime(1200);
      expect(sockets).toHaveLength(2);
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

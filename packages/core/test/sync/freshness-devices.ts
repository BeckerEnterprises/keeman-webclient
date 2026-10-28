/** Devices of one account on a fake server with a controllable clock. */
import { Account } from "../../src/account/account";
import { inMemoryKdfMemory } from "../../src/account/kdf-memory";
import { ApiClient } from "../../src/api/client";
import { emptyDraft } from "../../src/model/entry";
import type { Timers } from "../../src/sync/events";
import { inMemorySyncMarks, type SyncMarks } from "../../src/sync/marks";
import {
  FakeServer,
  fastWorker,
  type VaultRecord,
} from "../account/fake-server";
import { EMAIL, NAMES, PASSWORD, rootOf } from "./devices";

export const DAY = 86_400_000;

export class Clock {
  t = Date.parse("2026-10-27T08:00:00.000Z");
  readonly now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export function device(
  server: FakeServer,
  clock: Clock,
  marks: SyncMarks = inMemorySyncMarks(),
) {
  const api = new ApiClient({
    baseUrl: "http://localhost:18787",
    clientId: "test/1.0.0",
    fetch: server.fetch,
    sleep: () => Promise.resolve(),
  });
  const account = new Account({
    api,
    spawnWorker: fastWorker,
    device: { name: "Test · Node", client_type: "web" },
    kdfMemory: inMemoryKdfMemory(),
    syncMarks: marks,
    now: clock.now,
  });
  return { account, marks };
}

let invites = 0;

export async function register(
  server: FakeServer,
  clock: Clock,
  email: string,
  timers?: Timers,
) {
  const code = `FRESH-${String(++invites)}`;
  server.invites.add(code);
  const d = device(server, clock);
  const pending = await d.account.startRegistration({
    email,
    password: PASSWORD,
    inviteCode: code,
    language: "de",
  });
  await pending.submit();
  const engine = d.account.startSync(timers ? { timers } : {});
  await engine.refresh();
  return { server, clock, email, ...d, engine };
}

export async function first(
  server = new FakeServer(),
  clock = new Clock(),
  timers?: Timers,
) {
  const someone = await register(server, clock, EMAIL, timers);
  const vaultId = await someone.engine.createVault(NAMES);
  return { ...someone, vaultId };
}

export async function another(
  server: FakeServer,
  clock: Clock,
  marks?: SyncMarks,
  timers?: Timers,
) {
  const d = device(server, clock, marks);
  await d.account.login(EMAIL, PASSWORD);
  const engine = d.account.startSync(timers ? { timers } : {});
  await engine.refresh();
  return { ...d, engine };
}

export function puts(server: FakeServer, suffix: string): number {
  return server.log.filter((r) => r.method === "PUT" && r.path.endsWith(suffix))
    .length;
}

export function withhold(server: FakeServer): void {
  server.tamperVaults = (list) => {
    for (const item of list) item.freshness = null;
  };
  server.tamperMe = (me) => {
    me.freshness = null;
  };
}

export function entry(
  engine: Awaited<ReturnType<typeof first>>["engine"],
  id: string,
) {
  return engine.createEntry(id, rootOf(engine, id), {
    ...emptyDraft(),
    title: "Neu",
  });
}

export function snapshotVault(server: FakeServer, id: string): VaultRecord {
  const record = server.vaults.get(id);
  if (!record) throw new Error("no vault");
  return structuredClone(record);
}

/** Lets fire-and-forget uploads of the fake server finish. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

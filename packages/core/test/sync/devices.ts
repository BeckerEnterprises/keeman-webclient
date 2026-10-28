/** Devices of one account against the fake server, for sync tests. */
import { Account } from "../../src/account/account";
import { inMemoryKdfMemory } from "../../src/account/kdf-memory";
import { ApiClient } from "../../src/api/client";
import { fromBase64Url, toBase64Url } from "../../src/crypto/bytes";
import type {
  ItemRef,
  SyncEngine,
  TreeNode,
  VaultView,
} from "../../src/sync/engine";
import type { Timers } from "../../src/sync/events";
import { inMemorySyncMarks, type SyncMarks } from "../../src/sync/marks";
import {
  FakeServer,
  fastWorker,
  type StoredObject,
} from "../account/fake-server";

/** Timers a test fires by hand. */
export class ManualTimers implements Timers {
  readonly pending = new Map<number, { run: () => void; ms: number }>();
  #next = 0;
  setTimeout(run: () => void, ms: number): unknown {
    const id = ++this.#next;
    this.pending.set(id, { run, ms });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Runs every timer of at most `ms`. */
  fire(ms: number): void {
    for (const [id, timer] of [...this.pending])
      if (timer.ms <= ms) {
        this.pending.delete(id);
        timer.run();
      }
  }
}

export const PASSWORD = "correct horse battery staple";
export const EMAIL = "alice@example.com";
export const NAMES = {
  name: "Persönlich",
  rootName: "Persönlich",
  recycleBinName: "Papierkorb",
};

export function newAccount(
  server: FakeServer,
  marks: SyncMarks = inMemorySyncMarks(),
) {
  const api = new ApiClient({
    baseUrl: "http://localhost:18787",
    clientId: "test/1.0.0",
    fetch: server.fetch,
    sleep: () => Promise.resolve(),
  });
  const kdfMemory = inMemoryKdfMemory();
  const account = new Account({
    api,
    spawnWorker: fastWorker,
    device: { name: "Test · Node", client_type: "web" },
    kdfMemory,
    syncMarks: marks,
  });
  return { account, api, marks, kdfMemory };
}

export async function firstDevice(
  server = new FakeServer(),
  pageLimit?: number,
) {
  server.invites.add("INVITE");
  const device = newAccount(server);
  const pending = await device.account.startRegistration({
    email: EMAIL,
    password: PASSWORD,
    inviteCode: "INVITE",
    language: "de",
  });
  await pending.submit();
  const engine = device.account.startSync({ pageLimit });
  await engine.refresh();
  const vaultId = await engine.createVault(NAMES);
  return { server, ...device, engine, vaultId };
}

export async function secondDevice(
  server: FakeServer,
  pageLimit?: number,
  marks?: SyncMarks,
) {
  const device = newAccount(server, marks);
  await device.account.login(EMAIL, PASSWORD);
  const engine = device.account.startSync({ pageLimit });
  await engine.refresh();
  return { ...device, engine };
}

/** The head a roles warning or "take over" shows, as the app passes it back. */
export function shownHead(
  engine: SyncEngine,
  id: string,
): { head: { version: number; hash: string } | null } {
  return { head: vault(engine, id).roles.head ?? null };
}

export function vault(engine: SyncEngine, id: string): VaultView {
  const view = engine.snapshot.vaults.find((v) => v.id === id);
  if (!view) throw new Error("vault missing");
  return view;
}

export function node(
  engine: SyncEngine,
  vaultId: string,
  id: string,
): TreeNode {
  const found = vault(engine, vaultId).tree.nodes.get(id);
  if (!found) throw new Error("node missing");
  return found;
}

export function rootOf(engine: SyncEngine, vaultId: string): string {
  return (
    engine.snapshot.vaults.find((v) => v.id === vaultId)?.tree.rootId ?? ""
  );
}

export function binOf(engine: SyncEngine, vaultId: string): string {
  return vault(engine, vaultId).tree.binId ?? "";
}

export function names(
  engine: SyncEngine,
  vaultId: string,
  ids: readonly string[],
): string[] {
  return ids.map(
    (id) =>
      vault(engine, vaultId).tree.nodes.get(id)?.name ??
      vault(engine, vaultId).entries.get(id)?.title ??
      id,
  );
}

export function stored(
  server: FakeServer,
  vaultId: string,
  id: string,
): StoredObject {
  const object = server.vaults.get(vaultId)?.objects.get(id);
  if (!object) throw new Error("object missing");
  return object;
}

/** Flips one byte inside the ciphertext of an envelope. */
export function flipped(data: string): string {
  const bytes = fromBase64Url(data);
  bytes[30] = (bytes[30] ?? 0) ^ 1;
  return toBase64Url(bytes);
}

export const groupRef = (id: string): ItemRef => ({ kind: "group", id });
export const entryRef = (id: string): ItemRef => ({ kind: "entry", id });

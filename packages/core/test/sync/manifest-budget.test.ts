/**
 * Budget of the manifest in a vault with 10 000 objects: saving one entry
 * carries the root and one shard, together at most 40 KiB of `data`
 * (instead of the whole list), and checking the whole state stays fast.
 * Generous time bounds for slow machines and coverage runs.
 */
import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../src/api/client";
import type { VaultSummary } from "../../src/api/schemas";
import { KeyStore } from "../../src/crypto/keystore";
import { systemRandomness } from "../../src/crypto/random";
import { bucketOf, isManifestId, objectHash } from "../../src/model/manifest";
import { verifyManifest } from "../../src/sync/manifest";
import { inMemorySyncMarks } from "../../src/sync/marks";
import { VaultState } from "../../src/sync/vault";
import { WriteOperation } from "../../src/sync/writer";
import { IDS, tv } from "../helpers";

const OBJECTS = 10_000;

describe("budget of the manifest", () => {
  it("saves one entry of 10 000 with the root and one shard", async () => {
    const vaultId = systemRandomness.id("vault");
    const keys = new KeyStore();
    keys.unlock({
      userId: IDS.user,
      userKey: tv("uk", 32),
      privateKey: tv("sk", 32),
      publicKey: tv("pk", 32),
    });
    keys.setVaultKey(vaultId, 1, systemRandomness.bytes("vk", 32));
    const now = "2026-10-27T08:00:00.000Z";
    const state = new VaultState({
      vault_id: vaultId,
      role: "owner",
      state: "active",
      revision: 1,
      vault_key_version: 1,
      member_key_version: 1,
      member_count: 1,
      created: now,
    } as unknown as VaultSummary);
    state.synced = true;
    state.since = 1;
    const meta = {
      schema: 1,
      seq: 1,
      name: "V",
      rootGroupId: systemRandomness.id("root"),
    };
    state.objects.set(vaultId, {
      id: vaultId,
      type: "vault_meta",
      revision: 1,
      keyVersion: 1,
      raw: meta,
      seq: 1,
      readOnly: false,
      rollback: false,
      invalid: false,
    });
    const serve = (id: string, type: "vault_meta" | "entry", data: string) =>
      state.served.set(id, {
        type,
        revision: 1,
        hash: objectHash(vaultId, id, type, 1, data),
        bucket: bucketOf(id),
      });
    serve(vaultId, "vault_meta", "meta");
    for (let i = 0; i < OBJECTS; i++)
      serve(systemRandomness.id("entry"), "entry", `entry-${String(i)}`);

    const bodies: string[] = [];
    let revision = 1;
    const api = {
      batch: (_vault: string, _key: string, body: string) => {
        bodies.push(body);
        revision++;
        const ops = (JSON.parse(body) as { ops: { id: string }[] }).ops;
        return Promise.resolve({
          vault_revision: revision,
          results: ops.map((op) => ({ id: op.id, revision })),
        });
      },
    } as unknown as ApiClient;
    const context = {
      api,
      keys,
      userId: IDS.user,
      marks: inMemorySyncMarks(),
    };
    const operation = (
      plan: ConstructorParameters<typeof WriteOperation>[2],
      mode?: "create",
    ) =>
      new WriteOperation(
        context,
        state,
        plan,
        () => Promise.resolve(),
        () => now,
        mode,
      );

    // Create the manifest of the existing vault.
    await operation((current) => {
      const raw = current.meta?.raw ?? meta;
      return [
        {
          kind: "update",
          id: vaultId,
          baseRaw: raw,
          baseRevision: current.meta?.revision ?? 1,
          local: { ...raw, seq: 2, manifest: true },
        },
      ];
    }, "create").run();
    expect(state.manifest.status).toBe("verified");

    // Save one more entry.
    await operation(() => [
      {
        kind: "create",
        id: systemRandomness.id("entry"),
        type: "entry",
        content: {
          schema: 1,
          seq: 1,
          parentId: meta.rootGroupId,
          title: "Neu",
        },
      },
    ]).run();
    const ops = (
      JSON.parse(bodies.at(-1) ?? "{}") as {
        ops: { id: string; data: string }[];
      }
    ).ops;
    const manifest = ops.filter((op) => isManifestId(vaultId, op.id));
    expect(manifest).toHaveLength(2);
    const size = manifest.reduce((sum, op) => sum + op.data.length, 0);
    expect(size).toBeLessThanOrEqual(40 * 1024);

    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      expect(verifyManifest(state, undefined).status).toBe("verified");
      times.push(performance.now() - start);
    }
    expect(Math.min(...times)).toBeLessThan(1000);
  });
});

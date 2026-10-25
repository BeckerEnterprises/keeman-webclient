/**
 * Performance budget: 5 levels, 363 groups, 2000 entries with 3
 * snapshots each. Decrypting and projecting stays fast, a change rebuilds
 * quickly, the search is near instant. Generous bounds for slow machines.
 */
import { describe, expect, it } from "vitest";
import type { VaultSummary } from "../../src/api/schemas";
import { KeyStore } from "../../src/crypto/keystore";
import { encryptObject } from "../../src/crypto/objects";
import { systemRandomness } from "../../src/crypto/random";
import { searchTerms } from "../../src/search/normalize";
import { SearchIndex } from "../../src/search/index";
import { decode, VaultState } from "../../src/sync/vault";
import { VaultProjection } from "../../src/sync/views";
import { IDS, tv } from "../helpers";

const collator = new Intl.Collator("de", { numeric: true });

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe("budget of the projection", () => {
  it("decrypts and projects 2000 entries in 363 groups quickly", () => {
    const vaultId = systemRandomness.id("vault");
    const keys = new KeyStore();
    keys.unlock({
      userId: IDS.user,
      userKey: tv("uk", 32),
      privateKey: tv("sk", 32),
      publicKey: tv("pk", 32),
    });
    keys.setVaultKey(vaultId, 1, systemRandomness.bytes("vk", 32));
    const now = "2026-10-23T08:00:00.000Z";
    const root = systemRandomness.id("root");
    const raws: {
      id: string;
      type: "vault_meta" | "group" | "entry";
      raw: Record<string, unknown>;
    }[] = [
      {
        id: vaultId,
        type: "vault_meta",
        raw: {
          schema: 1,
          seq: 1,
          name: "V",
          rootGroupId: root,
          recycleBinGroupId: null,
        },
      },
      {
        id: root,
        type: "group",
        raw: { schema: 1, seq: 1, name: "Root", parentId: null },
      },
    ];
    let level = [root];
    const leaves: string[] = [];
    for (let depth = 1; depth <= 5; depth++) {
      const next: string[] = [];
      for (const parent of level)
        for (let i = 0; i < 3; i++) {
          const id = systemRandomness.id("group");
          raws.push({
            id,
            type: "group",
            raw: {
              schema: 1,
              seq: 1,
              name: `G ${String(depth)}.${String(i)}`,
              parentId: parent,
              sortKey: `a${String(i)}`,
            },
          });
          next.push(id);
        }
      level = next;
      if (depth === 5) leaves.push(...next);
    }
    expect(raws.filter((r) => r.type === "group")).toHaveLength(364);
    for (let i = 0; i < 2000; i++) {
      const snapshot = (n: number) => ({
        schema: 1,
        seq: n,
        title: `Eintrag ${String(i)}`,
        username: `user${String(i)}`,
        password: `pw-${String(n)}`,
        url: "https://example.com",
        modified: now,
      });
      raws.push({
        id: systemRandomness.id("entry"),
        type: "entry",
        raw: {
          schema: 1,
          seq: 4,
          parentId: leaves[i % leaves.length],
          title: `Eintrag ${String(i)} Straße`,
          username: `user${String(i)}`,
          password: "geheim",
          url: "https://example.com/login",
          notes: "Notiz ".repeat(20),
          tags: ["kunde"],
          fields: [
            {
              id: systemRandomness.id("field"),
              name: "Host",
              value: `host-${String(i)}`,
              protected: false,
            },
          ],
          history: [snapshot(3), snapshot(2), snapshot(1)],
          modified: now,
        },
      });
    }
    const changes = keys.useVaultKey(vaultId, 1, (key) =>
      raws.map((r, i) => ({
        id: r.id,
        type: r.type,
        revision: i + 1,
        key_version: 1,
        deleted: false,
        data: encryptObject(
          systemRandomness,
          key,
          { vaultId, objectId: r.id, type: r.type, keyVersion: 1 },
          r.raw,
        ),
        updated_at: now,
        updated_by: vaultId,
      })),
    );
    const summary = {
      vault_id: vaultId,
      role: "owner",
      state: "active",
      revision: raws.length,
      vault_key_version: 1,
      member_key_version: 1,
      member_count: 1,
      created: now,
    } as unknown as VaultSummary;

    const builds: number[] = [];
    const rebuilds: number[] = [];
    const searches: number[] = [];
    for (let run = 0; run < 5; run++) {
      const state = new VaultState(summary);
      state.synced = true;
      const start = performance.now();
      for (const change of changes) {
        const decoded = decode(keys, vaultId, change);
        if (decoded.kind === "object")
          state.objects.set(decoded.entry.id, decoded.entry);
      }
      const projection = new VaultProjection(vaultId);
      const view = projection.view(state, collator);
      builds.push(performance.now() - start);
      expect(view.entries.size).toBe(2000);
      expect(view.tree.nodes.size).toBe(364);

      // One entry changes.
      const changed = [...state.objects.values()].find(
        (o) => o.type === "entry",
      );
      if (!changed) throw new Error("no entry");
      state.objects.set(changed.id, {
        ...changed,
        raw: { ...changed.raw, title: "Neu" },
        revision: changed.revision + 1,
      });
      const again = performance.now();
      const next = projection.view(state, collator);
      rebuilds.push(performance.now() - again);
      expect(next.entries.get(changed.id)?.title).toBe("Neu");

      const index = new SearchIndex();
      const entries = [...state.objects.values()]
        .filter((o) => o.type === "entry")
        .map((o) => projection.entry(o.id));
      const terms = searchTerms("strasse 199");
      for (const entry of entries)
        if (entry) index.matches(entry, terms, false);
      const searchStart = performance.now();
      const hits = entries.filter(
        (entry) =>
          entry && index.matches(entry, searchTerms("strasse 1999"), false),
      );
      searches.push(performance.now() - searchStart);
      expect(hits).toHaveLength(1);
    }
    console.log(
      `budget: build ${median(builds).toFixed(0)} ms, rebuild ${median(rebuilds).toFixed(1)} ms, search ${median(searches).toFixed(1)} ms`,
    );
    expect(median(builds)).toBeLessThan(1500);
    expect(median(rebuilds)).toBeLessThan(30);
    expect(median(searches)).toBeLessThan(10);
  });
});

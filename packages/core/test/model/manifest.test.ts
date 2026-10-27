import { describe, expect, it } from "vitest";
import {
  bucketOf,
  checkManifest,
  inspectManifest,
  isManifestId,
  MANIFEST_SHARDS,
  manifestIds,
  objectHash,
  rootRaw,
  shardRaw,
  type ManifestEntry,
  type ManifestInput,
  type ManifestRead,
  type Served,
} from "../../src/model/manifest";

// Expected values computed independently with Python's hashlib.blake2b.
const VAULT = "0192f0a1-0000-7000-8000-000000000001";
const OBJECT = "0192f0a1-0000-7000-8000-000000000002";
const HASH = "eRTRBwAOOe_3BolAmPs-QRjYyPMLzDUMZcXO6ScDTlc";

describe("manifest IDs, buckets and hashes", () => {
  it("derives fixed UUIDv8 IDs from the vault ID", () => {
    const ids = manifestIds(VAULT);
    expect(ids.root).toBe("90c59180-834e-8b34-aad8-8dfa1ff9f2b6");
    expect(ids.shards[0]).toBe("79be765c-42de-82a0-90ff-6d2e2fb7219d");
    expect(ids.shards[63]).toBe("33746697-f1e6-80dc-8218-3a41e5656250");
    expect(new Set([ids.root, ...ids.shards]).size).toBe(MANIFEST_SHARDS + 1);
    expect(isManifestId(VAULT, ids.root)).toBe(true);
    expect(isManifestId(VAULT, OBJECT)).toBe(false);
    expect(isManifestId(OBJECT, ids.root)).toBe(false);
  });

  it("puts objects into buckets by hash, not by time", () => {
    expect(bucketOf(OBJECT)).toBe(10);
    expect(bucketOf("01930065-0000-4000-8000-000000000065")).toBe(23);
    expect(bucketOf("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(0);
  });

  it("hashes AAD and data text, also without data", () => {
    expect(objectHash(VAULT, OBJECT, "entry", 3, "AQID")).toBe(HASH);
    expect(objectHash(VAULT, OBJECT, "entry", 3, null)).toBe(
      "B9gfcHFSgBrmWaOpUycDLeD4WNQ03VQEz2h490pPE74",
    );
    // Type and key version are part of it.
    expect(objectHash(VAULT, OBJECT, "group", 3, "AQID")).not.toBe(HASH);
    expect(objectHash(VAULT, OBJECT, "entry", 4, "AQID")).not.toBe(HASH);
  });
});

function entries(...list: [string, ManifestEntry][]) {
  return new Map(list);
}

/** An ID in the given bucket. */
function inBucket(k: number, skip = 0): string {
  let found = 0;
  for (let n = 1; ; n++) {
    const id = `0192f0a1-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
    if (bucketOf(id) === k && found++ === skip) return id;
  }
}

describe("reading manifest objects", () => {
  const ids = manifestIds(VAULT);
  const shardId = ids.shards[10] ?? "";
  const root = rootRaw(
    undefined,
    Array.from({ length: 64 }, (_, k) => (k === 10 ? [2, HASH] : null)),
    5,
  );
  const shard = shardRaw(undefined, entries([OBJECT, ["entry", HASH]]), 2);

  it("accepts a root and a shard under their IDs", () => {
    const r = inspectManifest(root, ids.root, VAULT);
    expect(r).toMatchObject({ status: "ok", seq: 5, value: { kind: "root" } });
    const s = inspectManifest(shard, shardId, VAULT);
    expect(s.status === "ok" && s.value).toMatchObject({
      kind: "shard",
      index: 10,
    });
  });

  it("marks broken ones as corrupt", () => {
    const corrupt = { status: "corrupt", reason: "validation" };
    const shards = (root.shards as unknown[]).slice(0, 63);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...root, shards }, ids.root],
      [{ ...root, shards: [...shards, [0, HASH]] }, ids.root],
      [{ ...root, shards: [...shards, [1, "AAAA"]] }, ids.root],
      [root, OBJECT],
      [shard, ids.root],
      [shard, ids.shards[11] ?? ""],
      [{ ...shard, objects: { [OBJECT]: ["manifest", HASH] } }, shardId],
      [{ ...shard, objects: { [OBJECT]: ["Entry", HASH] } }, shardId],
      [{ ...shard, objects: { [OBJECT]: ["entry", HASH, 1] } }, shardId],
      [{ ...shard, objects: { [ids.root]: ["entry", HASH] } }, shardId],
      [{ ...shard, seq: 0 }, shardId],
    ];
    for (const [raw, id] of cases)
      expect(inspectManifest(raw, id, VAULT), JSON.stringify(raw)).toEqual(
        corrupt,
      );
  });

  it("reads a newer schema no further and keeps later object types", () => {
    const newer = inspectManifest(
      { schema: 2, seq: 1, shards: "later" },
      ids.root,
      VAULT,
    );
    expect(newer).toMatchObject({
      status: "ok",
      readOnly: true,
      value: { kind: "newer" },
    });
    const later = inspectManifest(
      { ...shard, objects: { [OBJECT]: ["note_v2", HASH] } },
      shardId,
      VAULT,
    );
    expect(later.status).toBe("ok");
  });

  it("keeps unknown top-level fields when writing", () => {
    const base = { ...root, owners: ["x"] };
    expect(rootRaw(base, root.shards as [number, string][], 6)).toMatchObject({
      owners: ["x"],
      seq: 6,
    });
    const shardBase = { ...shard, note: 1 };
    expect(shardRaw(shardBase, new Map(), 3)).toEqual({
      schema: 1,
      seq: 3,
      objects: {},
      note: 1,
    });
  });
});

describe("checking a delivered state", () => {
  const ids = manifestIds(VAULT);
  const a = inBucket(3);
  const b = inBucket(3, 1);
  const c = inBucket(40);

  /** A consistent state: two shards, three objects. */
  function state() {
    const served = new Map<string, Served>();
    const reads = new Map<string, ManifestRead>();
    const put = (id: string, type: string, revision = 1) =>
      served.set(id, {
        type,
        revision,
        hash: objectHash(VAULT, id, type, 1, `data-${id}`),
        bucket: bucketOf(id),
      });
    for (const [id, type] of [
      [a, "entry"],
      [b, "group"],
      [c, "icon"],
    ] as const)
      put(id, type);
    const shardRoot: ([number, string] | null)[] = Array.from(
      { length: 64 },
      () => null,
    );
    for (const k of [3, 40]) {
      const list = [...served].filter(([, s]) => s.bucket === k);
      const raw = shardRaw(
        undefined,
        new Map(list.map(([id, s]) => [id, [s.type, s.hash]])),
        4,
      );
      const id = ids.shards[k] ?? "";
      const inspected = inspectManifest(raw, id, VAULT);
      if (inspected.status !== "ok") throw new Error("shard");
      reads.set(id, {
        kind: "ok",
        seq: 4,
        raw,
        value: inspected.value as never,
      });
      const hash = objectHash(VAULT, id, "manifest", 1, `data-${id}`);
      served.set(id, {
        type: "manifest",
        revision: 2,
        hash,
        bucket: bucketOf(id),
      });
      shardRoot[k] = [4, hash];
    }
    const raw = rootRaw(undefined, shardRoot, 9);
    const inspected = inspectManifest(raw, ids.root, VAULT);
    if (inspected.status !== "ok") throw new Error("root");
    reads.set(ids.root, {
      kind: "ok",
      seq: 9,
      raw,
      value: inspected.value as never,
    });
    served.set(ids.root, {
      type: "manifest",
      revision: 2,
      hash: "root",
      bucket: bucketOf(ids.root),
    });
    const input: ManifestInput = {
      vaultId: VAULT,
      served,
      read: (id) => reads.get(id) ?? { kind: "absent" },
      flagged: true,
      floor: 0,
    };
    return { input, served, reads, put };
  }

  it("verifies a complete state", () => {
    const { input } = state();
    expect(checkManifest(input)).toEqual({
      status: "verified",
      issues: [],
      rootHash: "root",
    });
  });

  it("finds missing, differing and unlisted objects", () => {
    const missing = state();
    missing.served.delete(a);
    expect(checkManifest(missing.input)).toEqual({
      status: "mismatch",
      issues: [{ id: a, type: "entry", reason: "missing" }],
    });
    const differs = state();
    differs.put(b, "group", 5);
    const relabelled = differs.served.get(b);
    if (relabelled)
      relabelled.hash = objectHash(VAULT, b, "group", 2, `data-${b}`);
    expect(checkManifest(differs.input).issues).toEqual([
      { id: b, type: "group", reason: "differs" },
    ]);
    const unlisted = state();
    const extra = inBucket(3, 2);
    const other = inBucket(7);
    unlisted.put(extra, "entry");
    unlisted.put(other, "entry");
    expect(checkManifest(unlisted.input).issues).toEqual([
      { id: extra, type: "entry", reason: "unlisted" },
      { id: other, type: "entry", reason: "unlisted" },
    ]);
  });

  it("finds missing, changed and corrupt shards", () => {
    const shard3 = ids.shards[3] ?? "";
    const gone = state();
    gone.served.delete(shard3);
    // Its objects cannot be checked then; the missing shard is the finding.
    expect(checkManifest(gone.input).issues).toEqual([
      { id: shard3, type: "manifest", reason: "missing" },
    ]);
    const corrupt = state();
    corrupt.reads.set(shard3, { kind: "corrupt", reason: "auth" });
    expect(checkManifest(corrupt.input).status).toBe("mismatch");
    const stray = state();
    stray.served.set(ids.shards[9] ?? "", {
      type: "manifest",
      revision: 3,
      hash: HASH,
      bucket: 0,
    });
    expect(checkManifest(stray.input).issues).toEqual([
      { id: ids.shards[9], type: "manifest", reason: "unlisted" },
    ]);
  });

  it("tells a missing root from a vault without manifest", () => {
    const none = state();
    for (const id of [ids.root, ...ids.shards]) none.served.delete(id);
    none.reads.clear();
    expect(checkManifest({ ...none.input, flagged: false }).status).toBe(
      "unverified",
    );
    expect(checkManifest(none.input).status).toBe("mismatch");
    expect(
      checkManifest({ ...none.input, flagged: false, floor: 3 }).status,
    ).toBe("mismatch");
  });

  it("is unknown, not a mismatch, without a key or for a newer format", () => {
    const noKey = state();
    noKey.reads.set(ids.root, { kind: "corrupt", reason: "no_key" });
    expect(checkManifest(noKey.input).status).toBe("unknown");
    const newer = state();
    newer.reads.set(ids.shards[40] ?? "", { kind: "newer" });
    expect(checkManifest(newer.input).status).toBe("unknown");
    // A finding elsewhere still counts.
    newer.served.delete(a);
    expect(checkManifest(newer.input).status).toBe("mismatch");
  });

  it("ignores manifest objects under other IDs", () => {
    const { input, served } = state();
    served.set(inBucket(5), {
      type: "manifest",
      revision: 3,
      hash: HASH,
      bucket: 5,
    });
    expect(checkManifest(input).status).toBe("verified");
  });
});

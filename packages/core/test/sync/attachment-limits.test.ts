import { describe, expect, it, vi } from "vitest";
import { concatBytes, utf8Encode } from "../../src/crypto/bytes";
import { encryptedBlobSize } from "../../src/crypto/secretstream";
import { emptyDraft } from "../../src/model/entry";
import type { SyncEngine } from "../../src/sync/engine";
import { firstDevice, rootOf, secondDevice } from "./devices";

// The size in an entry comes from whoever added the attachment. What a
// client unpacks and downloads is bounded independently of it.

vi.mock("../../src/kdbx/export", async (original) => ({
  ...(await original<typeof import("../../src/kdbx/export")>()),
  // Small for the test; the real total is 1 GiB.
  KDBX_EXPORT_ATTACHMENT_BYTES: 50_000,
}));

/** Text compresses well: a small blob that unpacks big. */
function text(length: number): Uint8Array {
  return utf8Encode("x".repeat(length));
}

async function entryWith(
  engine: SyncEngine,
  vaultId: string,
  files: Uint8Array[],
): Promise<{ id: string; attachments: string[] }> {
  const id = engine.newEntryId();
  const attachments: string[] = [];
  for (const [index, data] of files.entries()) {
    const info = await engine.stageAttachment(vaultId, id, {
      name: `${String(index)}.txt`,
      mime: "text/plain",
      data,
    });
    attachments.push(info.id);
  }
  await engine.createEntry(
    vaultId,
    rootOf(engine, vaultId),
    { ...emptyDraft(), title: "Anhänge", attachments },
    id,
  );
  return { id, attachments };
}

describe("attachment limits", () => {
  it("reads nothing beyond the server's limit, whatever the entry says", async () => {
    const { engine, vaultId, server } = await firstDevice();
    const { id, attachments } = await entryWith(engine, vaultId, [
      text(200_000),
    ]);
    const [big = ""] = attachments;
    expect(server.attachments.get(big)?.blob?.length).toBeLessThan(5_000);
    // Another member's device knows a smaller limit than the stated size.
    server.attachmentMaxBytes = 100_000;
    const other = await secondDevice(server);
    const downloads = () =>
      server.log.filter(
        (r) => r.method === "GET" && r.path.endsWith(`/attachments/${big}`),
      ).length;
    const before = downloads();
    await expect(
      other.engine.readAttachment(vaultId, id, big),
    ).rejects.toMatchObject({ code: "attachment_too_large" });
    expect(downloads()).toBe(before);
  });

  it("reads a file exactly at the limit", async () => {
    const { engine, vaultId, server } = await firstDevice();
    server.attachmentMaxBytes = 100_000;
    const data = text(100_000);
    const { id, attachments } = await entryWith(engine, vaultId, [data]);
    const other = await secondDevice(server);
    expect(
      await other.engine.readAttachment(vaultId, id, attachments[0] ?? ""),
    ).toEqual(data);
  });

  it("stops a download larger than a blob of the stated size", async () => {
    const { engine, vaultId, server } = await firstDevice();
    const data = text(1000);
    const { id, attachments } = await entryWith(engine, vaultId, [data]);
    const [small = ""] = attachments;
    const stored = server.attachments.get(small);
    if (!stored?.blob) throw new Error("no blob");
    stored.blob = concatBytes(stored.blob, new Uint8Array(5_000_000));
    const seen: number[] = [];
    await expect(
      engine.readAttachment(vaultId, id, small, {
        onProgress: (p) => seen.push(p.done),
      }),
    ).rejects.toMatchObject({ code: "attachment_corrupt" });
    expect(Math.max(0, ...seen)).toBeLessThanOrEqual(encryptedBlobSize(1000));
  });

  it("exports at most the total of attachments and names the rest", async () => {
    const { engine, vaultId, server } = await firstDevice();
    const { attachments } = await entryWith(engine, vaultId, [
      text(30_000),
      text(30_000),
      text(10_000),
    ]);
    const { model, report } = await engine.exportKdbx(vaultId);
    // 30 000 fits, the second 30 000 would pass 50 000, 10 000 still fits.
    expect(model.binaries.map((b) => b.length)).toEqual([30_000, 10_000]);
    expect(
      report.items
        .filter((item) => item.kind === "attachment_too_large")
        .map((item) => ("name" in item ? item.name : "")),
    ).toEqual(["1.txt"]);
    // One over the server's limit is named as well.
    server.attachmentMaxBytes = 20_000;
    const other = await secondDevice(server);
    const second = await other.engine.exportKdbx(vaultId);
    expect(second.model.binaries.map((b) => b.length)).toEqual([10_000]);
    expect(
      second.report.items.filter(
        (item) => item.kind === "attachment_too_large",
      ),
    ).toHaveLength(2);
    expect(attachments).toHaveLength(3);
  });

  it("skips an attachment over what is left without downloading it", async () => {
    const { engine, vaultId, server } = await firstDevice();
    const { attachments } = await entryWith(engine, vaultId, [
      text(30_000),
      text(30_000),
    ]);
    const downloads = (id: string) =>
      server.log.filter(
        (r) => r.method === "GET" && r.path.endsWith(`/attachments/${id}`),
      ).length;
    await engine.exportKdbx(vaultId);
    expect(downloads(attachments[0] ?? "")).toBe(1);
    expect(downloads(attachments[1] ?? "")).toBe(0);
  });

  it("checks the length actually read, not only the stated size", async () => {
    const { engine, vaultId } = await firstDevice();
    await entryWith(engine, vaultId, [text(10_000), text(10_000)]);
    // A file longer than its entry claims, e.g. after a change meanwhile.
    const read = vi
      .spyOn(engine, "readAttachment")
      .mockResolvedValueOnce(new Uint8Array(60_000));
    const { model, report } = await engine.exportKdbx(vaultId);
    read.mockRestore();
    expect(model.binaries.map((b) => b.length)).toEqual([10_000]);
    expect(
      report.items
        .filter((item) => item.kind === "attachment_too_large")
        .map((item) => ("name" in item ? item.name : "")),
    ).toEqual(["0.txt"]);
  });

  it("hands nothing out once a lock stopped the engine", async () => {
    const { account, engine, vaultId, server } = await firstDevice();
    const { id, attachments } = await entryWith(engine, vaultId, [text(1000)]);
    const [stored = ""] = attachments;
    // Reading: the download arrives after the lock.
    server.onRequest = (method, path) => {
      if (method !== "GET" || !path.endsWith(`/attachments/${stored}`)) return;
      server.onRequest = () => undefined;
      account.lock();
    };
    await expect(
      engine.readAttachment(vaultId, id, stored),
    ).rejects.toMatchObject({ code: "locked" });
  });

  it("stages nothing once a lock stopped the engine", async () => {
    const { account, engine, vaultId, server } = await firstDevice();
    const entryId = engine.newEntryId();
    server.onRequest = (method, path) => {
      if (method !== "POST" || !path.endsWith("/attachments")) return;
      server.onRequest = () => undefined;
      account.lock();
    };
    await expect(
      engine.stageAttachment(vaultId, entryId, {
        name: "a.txt",
        mime: "text/plain",
        data: text(1000),
      }),
    ).rejects.toMatchObject({ code: "locked" });
    const puts = server.log.filter(
      (r) => r.method === "PUT" && r.path.includes("/parts/"),
    );
    expect(puts).toHaveLength(0);
  });
});

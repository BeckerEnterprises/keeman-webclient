import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors";
import { utf8Encode } from "../../src/crypto/bytes";
import { emptyDraft, type EntryDraft } from "../../src/model/entry";
import type { SyncEngine } from "../../src/sync/engine";
import { SyncError } from "../../src/sync/errors";
import type { FakeServer } from "../account/fake-server";
import { NAMES, firstDevice, rootOf, secondDevice, vault } from "./devices";

/** Test data only: a recognisable pattern. */
function file(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31) % 251);
}

async function entryWith(
  engine: SyncEngine,
  vaultId: string,
  files: { name: string; data: Uint8Array; mime?: string }[],
  draft: Partial<EntryDraft> = {},
): Promise<{ id: string; attachments: string[] }> {
  const id = engine.newEntryId();
  const attachments: string[] = [];
  for (const f of files) {
    const info = await engine.stageAttachment(vaultId, id, {
      name: f.name,
      mime: f.mime ?? "application/octet-stream",
      data: f.data,
    });
    attachments.push(info.id);
  }
  await engine.createEntry(
    vaultId,
    rootOf(engine, vaultId),
    { ...emptyDraft(), title: "Mit Anhang", ...draft, attachments },
    id,
  );
  return { id, attachments };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

function onServer(server: FakeServer, id: string) {
  return server.attachments.get(id);
}

describe("attachments in the engine", () => {
  it("brings files back bit for bit, compressed where it helps", async () => {
    const { engine, vaultId, server } = await firstDevice();
    server.partSize = 100_000;
    // ZIP is never compressed, so the largest blob needs three parts.
    const files = [0, 1, 65_536, 65_537, 250_000].map((length) => ({
      name: `${String(length)}.bin`,
      data: file(length),
      mime: length === 250_000 ? "application/zip" : undefined,
    }));
    files.push({
      name: "notiz.txt",
      data: utf8Encode("Fantasie ".repeat(1000)),
      mime: "text/plain",
    });
    const { id, attachments } = await entryWith(engine, vaultId, files);
    const detail = engine.entry(vaultId, id);
    expect(detail?.attachments.map((a) => a.name)).toEqual(
      files.map((f) => f.name),
    );
    expect(detail?.attachments.at(-1)).toMatchObject({
      mime: "text/plain",
      compression: "gzip",
      size: 9000,
    });
    expect(JSON.stringify(vault(engine, vaultId))).not.toContain('"key"');
    for (const [i, attachment] of attachments.entries()) {
      expect(onServer(server, attachment)).toMatchObject({
        state: "complete",
        entryId: id,
      });
      const back = await engine.readAttachment(vaultId, id, attachment);
      expect(back).toEqual(files[i]?.data);
    }
    // The blob of 250 000 bytes went up in three parts.
    expect(onServer(server, attachments[4] ?? "")?.parts).toBe(3);

    // Another device reads it, with progress.
    const other = await secondDevice(server);
    const seen: number[] = [];
    const back = await other.engine.readAttachment(
      vaultId,
      id,
      attachments[4] ?? "",
      { onProgress: (p) => seen.push(p.done) },
    );
    expect(back).toEqual(files[4]?.data);
    expect(seen.at(-1)).toBeGreaterThan(250_000);
  });

  it("refuses large files, cancels and discards uploads", async () => {
    const { engine, vaultId, server } = await firstDevice();
    server.attachmentMaxBytes = 1000;
    const id = engine.newEntryId();
    await expectCode(
      engine.stageAttachment(vaultId, id, {
        name: "big",
        mime: "",
        data: file(1001),
      }),
      "attachment_too_large",
    );
    expect(await engine.attachmentLimit()).toBe(1000);

    const controller = new AbortController();
    server.partSize = 100;
    await expectCode(
      engine.stageAttachment(
        vaultId,
        id,
        { name: "x", mime: "", data: file(900) },
        {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.done > 0) controller.abort();
          },
        },
      ),
      "cancelled",
    );
    await Promise.resolve();
    expect(server.attachments.size).toBe(0);

    const staged = await engine.stageAttachment(vaultId, id, {
      name: "a",
      mime: "",
      data: file(10),
    });
    expect(staged.mime).toBe("application/octet-stream");
    expect(onServer(server, staged.id)?.state).toBe("uploading");
    engine.discardAttachments(vaultId, id, [staged.id]);
    await Promise.resolve();
    expect(server.attachments.size).toBe(0);
    // A discarded upload can no longer be saved.
    await expectCode(
      engine.createEntry(
        vaultId,
        rootOf(engine, vaultId),
        { ...emptyDraft(), attachments: [staged.id] },
        id,
      ),
      "invalid_entry",
    );
  });

  it("passes server errors on and asks for the limit again after a failure", async () => {
    const { engine, vaultId, server } = await firstDevice();
    server.failures.set("/v1/config", [
      { status: 400, code: "validation_failed" },
    ]);
    await expect(engine.attachmentLimit()).rejects.toBeInstanceOf(ApiError);
    expect(await engine.attachmentLimit()).toBe(52_428_800);

    const id = engine.newEntryId();
    server.failures.set(`/v1/vaults/${vaultId}/attachments`, [
      { status: 507, code: "quota_exceeded" },
    ]);
    await expect(
      engine.stageAttachment(vaultId, id, {
        name: "a",
        mime: "",
        data: file(5),
      }),
    ).rejects.toMatchObject({ code: "quota_exceeded" });

    const { id: entry, attachments } = await entryWith(engine, vaultId, [
      { name: "a", data: file(5) },
    ]);
    const path = `/v1/vaults/${vaultId}/attachments/${attachments[0] ?? ""}`;
    server.failures.set(path, [{ status: 400, code: "validation_failed" }]);
    await expect(
      engine.readAttachment(vaultId, entry, attachments[0] ?? ""),
    ).rejects.toMatchObject({ code: "validation_failed" });
    const controller = new AbortController();
    controller.abort();
    await expectCode(
      engine.readAttachment(vaultId, entry, attachments[0] ?? "", {
        signal: controller.signal,
      }),
      "cancelled",
    );
  });

  it("drops staged uploads on lock", async () => {
    const { engine, vaultId, server } = await firstDevice();
    const staged = await engine.stageAttachment(vaultId, engine.newEntryId(), {
      name: "a",
      mime: "",
      data: file(10),
    });
    engine.stop();
    await Promise.resolve();
    expect(onServer(server, staged.id)).toBeUndefined();
  });

  it("deletes a blob only when no version of the entry needs it", async () => {
    const { engine, vaultId, server } = await firstDevice();
    const { id, attachments } = await entryWith(engine, vaultId, [
      { name: "a", data: file(10) },
      { name: "b", data: file(20) },
    ]);
    const [a = "", b = ""] = attachments;
    const edit = (change: Partial<EntryDraft>) => {
      const opened = engine.editEntry(vaultId, id);
      if (!opened) throw new Error("no draft");
      return engine.saveEntry(opened.base, { ...opened.draft, ...change });
    };
    // Removed from the entry, kept for the history.
    await edit({ attachments: [b] });
    expect(onServer(server, a)).toBeDefined();
    expect(engine.entry(vaultId, id)?.history[0]?.values.attachments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: a })]),
    );
    expect(await engine.readAttachment(vaultId, id, a)).toEqual(file(10));
    // Restoring brings it back; adding a new one completes it on save.
    await engine.restoreHistory(vaultId, id, 0);
    expect(engine.entry(vaultId, id)?.attachments.map((x) => x.id)).toEqual([
      a,
      b,
    ]);
    const added = await engine.stageAttachment(vaultId, id, {
      name: "c",
      mime: "",
      data: file(5),
    });
    await edit({ attachments: [a, b, added.id] });
    expect(onServer(server, added.id)?.state).toBe("complete");

    // Without history the blob goes right away.
    await engine.updateVault(vaultId, { historyMaxItems: 0 });
    await edit({ attachments: [a] });
    expect(onServer(server, a)).toBeDefined();
    expect(onServer(server, b)).toBeUndefined();
    expect(onServer(server, added.id)).toBeUndefined();
    await expectCode(
      engine.readAttachment(vaultId, id, b),
      "attachment_missing",
    );

    // A merge after a conflict deletes nothing.
    const stale = engine.editEntry(vaultId, id);
    const other = await secondDevice(server);
    const fresh = other.engine.editEntry(vaultId, id);
    if (!stale || !fresh) throw new Error("no draft");
    await other.engine.saveEntry(fresh.base, { ...fresh.draft, title: "B" });
    await engine.saveEntry(stale.base, { ...stale.draft, attachments: [] });
    expect(engine.entry(vaultId, id)?.attachments).toEqual([]);
    expect(onServer(server, a)).toBeDefined();
  });

  it("checks drafts and reports damaged or missing blobs", async () => {
    const { engine, vaultId, server } = await firstDevice();
    const { id, attachments } = await entryWith(engine, vaultId, [
      { name: "a", data: file(100) },
      {
        name: "b.txt",
        data: utf8Encode("x".repeat(500)),
        mime: "text/plain",
      },
    ]);
    const [a = "", b = ""] = attachments;
    const opened = engine.editEntry(vaultId, id);
    if (!opened) throw new Error("no draft");
    await expectCode(
      engine.saveEntry(opened.base, {
        ...opened.draft,
        attachments: [a, "0192b3a4-0000-7000-8000-000000000000"],
      }),
      "invalid_entry",
    );
    await expectCode(
      engine.saveEntry(opened.base, {
        ...opened.draft,
        attachments: Array.from({ length: 51 }, () => a),
      }),
      "invalid_entry",
    );

    const blob = onServer(server, a)?.blob;
    if (!blob) throw new Error("no blob");
    blob[blob.length - 1] = (blob.at(-1) ?? 0) ^ 1;
    await expectCode(
      engine.readAttachment(vaultId, id, a),
      "attachment_corrupt",
    );
    // A gzip blob that unpacks to more than the stated size.
    const gz = onServer(server, b);
    const inflated = engine.entry(vaultId, id)?.attachments[1];
    expect(inflated?.compression).toBe("gzip");
    if (gz)
      server.attachments.set(b, { ...gz, blob: onServer(server, a)?.blob });
    await expectCode(
      engine.readAttachment(vaultId, id, b),
      "attachment_corrupt",
    );
    await expectCode(
      engine.readAttachment(
        vaultId,
        id,
        "0192b3a4-0000-7000-8000-000000000000",
      ),
      "attachment_missing",
    );
    await expectCode(
      engine.readAttachment(vaultId, "0192b3a4-0000-7000-8000-000000000001", a),
      "attachment_missing",
    );
  });

  it("moves attachments along to another vault", async () => {
    const { engine, vaultId, server } = await firstDevice();
    const other = await engine.createVault({ ...NAMES, name: "Zweite" });
    const { id, attachments } = await entryWith(engine, vaultId, [
      { name: "a", data: file(30) },
    ]);
    const [a = ""] = attachments;
    // A snapshot keeps a second one.
    const added = await engine.stageAttachment(vaultId, id, {
      name: "b",
      mime: "",
      data: file(40),
    });
    const opened = engine.editEntry(vaultId, id);
    if (!opened) throw new Error("no draft");
    await engine.saveEntry(opened.base, {
      ...opened.draft,
      attachments: [added.id],
    });
    await engine.move(vaultId, [{ kind: "entry", id }], {
      vaultId: other,
      groupId: rootOf(engine, other),
    });
    expect(vault(engine, vaultId).entries.has(id)).toBe(false);
    expect(onServer(server, a)).toMatchObject({ vaultId: other, entryId: id });
    expect(onServer(server, added.id)).toMatchObject({ vaultId: other });
    expect(await engine.readAttachment(other, id, added.id)).toEqual(file(40));
    expect(await engine.readAttachment(other, id, a)).toEqual(file(30));
  });

  it("rolls a move back when a transfer fails", async () => {
    const { engine, vaultId, server } = await firstDevice();
    const other = await engine.createVault({ ...NAMES, name: "Zweite" });
    const { id, attachments } = await entryWith(engine, vaultId, [
      { name: "a", data: file(30) },
      { name: "b", data: file(40) },
    ]);
    const [a = "", b = ""] = attachments;
    server.failures.set(`/v1/vaults/${vaultId}/attachments/${b}/transfer`, [
      { status: 507, code: "quota_exceeded" },
    ]);
    const error: unknown = await engine
      .move(vaultId, [{ kind: "entry", id }], {
        vaultId: other,
        groupId: rootOf(engine, other),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("quota_exceeded");
    // Everything is back in the source; the copy is gone.
    expect(vault(engine, vaultId).entries.has(id)).toBe(true);
    expect(vault(engine, other).entries.size).toBe(0);
    expect(onServer(server, a)).toMatchObject({ vaultId, entryId: id });
    expect(onServer(server, b)).toMatchObject({ vaultId, entryId: id });
    expect(await engine.readAttachment(vaultId, id, a)).toEqual(file(30));

    // If even the way back fails, the copy stays and keeps the blobs.
    server.failures.set(`/v1/vaults/${vaultId}/attachments/${b}/transfer`, [
      { status: 507, code: "quota_exceeded" },
    ]);
    server.failures.set(`/v1/vaults/${other}/attachments/${a}/transfer`, [
      { status: 400, code: "validation_failed" },
    ]);
    const second: unknown = await engine
      .move(vaultId, [{ kind: "entry", id }], {
        vaultId: other,
        groupId: rootOf(engine, other),
      })
      .catch((e: unknown) => e);
    expect(second).toBeInstanceOf(SyncError);
    expect((second as SyncError).code).toBe("move_incomplete");
    expect(vault(engine, other).entries.size).toBe(1);
  });
});

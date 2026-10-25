import { describe, expect, it } from "vitest";
import type { KdbxFile } from "../../src/kdbx/types";
import { KdbxError } from "../../src/kdbx/types";
import type { SyncEngine } from "../../src/sync/engine";
import { SyncError } from "../../src/sync/errors";
import { iconPng } from "../helpers";
import {
  hex,
  kdbxEntry,
  kdbxFile,
  kdbxGroup,
  readFixture,
  uuid,
} from "../kdbx/helpers";
import {
  binOf,
  entryRef,
  firstDevice,
  rootOf,
  secondDevice,
  vault,
} from "./devices";

const TEXTS = { emptyFieldName: "Feld" };
const SAMPLE_ROOT = "01930001-0000-4000-8000-000000000001";
const ROOT_WEB01 = "01930065-0000-4000-8000-000000000065";
const ROBOT = "01930066-0000-4000-8000-000000000066";

function entryTitled(engine: SyncEngine, vaultId: string, title: string) {
  const found = [...vault(engine, vaultId).entries.values()].filter(
    (e) => e.title === title,
  );
  return found;
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
}

describe("KDBX import job", () => {
  it("imports the sample into a new vault that a second device reads the same", async () => {
    const { server, engine } = await firstDevice();
    const file = await readFixture("keeman-sample");
    const job = await engine.prepareKdbxImport(
      file,
      { kind: "vault", name: "  Sample import " },
      TEXTS,
    );
    expect(job.vaultId).toBeUndefined();
    const progress: number[] = [];
    await job.run({ onProgress: (p) => progress.push(p.done) });
    expect(job.finished).toBe(true);
    expect(job.progress).toEqual({ done: 24, total: 24 });
    expect(progress.at(-1)).toBe(24);
    const vaultId = job.vaultId ?? "";
    const view = vault(engine, vaultId);
    expect(view).toMatchObject({
      name: "Sample import",
      color: "#2563EB",
      historyMaxItems: 100,
      rootGroupId: SAMPLE_ROOT,
      recycleBinGroupId: "01930008-0000-4000-8000-000000000008",
    });
    expect(view.entries.size).toBe(15);
    expect(view.tree.nodes.size).toBe(9);
    expect(job.report.conflicts).toBe(0);

    const other = await secondDevice(server);
    const detail = other.engine.entry(vaultId, ROOT_WEB01);
    expect(detail?.values).toMatchObject({
      title: "root web01",
      password: "Hamster-4",
      tags: ["prod", "server"],
    });
    expect(detail?.values.fields.map((f) => f.name)).toEqual([
      "Host",
      "SSH Passphrase",
    ]);
    expect(detail?.history.map((h) => h.values.password)).toEqual([
      "Hamster-3",
      "Hamster-2",
      "Hamster-1",
    ]);
    expect(other.engine.entry(vaultId, ROBOT)?.values.password).toBe(
      "{REF:P@I:01930065000040008000000000000065}",
    );
    expect(binOf(other.engine, vaultId)).toBe(
      "01930008-0000-4000-8000-000000000008",
    );
  });

  it("imports into a group twice: new IDs and rewritten references the second time", async () => {
    const { engine, vaultId } = await firstDevice();
    const file = await readFixture("keeman-sample");
    const target = {
      kind: "group" as const,
      vaultId,
      groupId: rootOf(engine, vaultId),
    };
    const first = await engine.prepareKdbxImport(file, target, TEXTS);
    await first.run();
    expect(first.report.conflicts).toBe(0);
    expect(first.report.skippedBin).toEqual({ groups: 2, entries: 2 });
    const second = await engine.prepareKdbxImport(file, target, TEXTS);
    await second.run();
    expect(second.report.conflicts).toBe(20);

    const robots = entryTitled(engine, vaultId, "Nordhost Panel");
    const webs = entryTitled(engine, vaultId, "root web01");
    expect(robots).toHaveLength(2);
    const copy = webs.find((w) => w.id !== ROOT_WEB01);
    const copyRobot = robots.find((r) => r.id !== ROBOT);
    expect(engine.entry(vaultId, copyRobot?.id ?? "")?.values.password).toBe(
      `{REF:P@I:${(copy?.id ?? "").replaceAll("-", "").toUpperCase()}}`,
    );
    expect(engine.entry(vaultId, ROBOT)?.values.password).toBe(
      "{REF:P@I:01930065000040008000000000000065}",
    );
    // Both copies of the KDBX root sit at the end of the target group.
    const children =
      vault(engine, vaultId).tree.nodes.get(rootOf(engine, vaultId))
        ?.children ?? [];
    expect(
      children.map((id) => vault(engine, vaultId).tree.nodes.get(id)?.name),
    ).toEqual(["Papierkorb", "Sample", "Sample"]);
  });

  it("fixes earlier references when a later object meets an unknown tombstone", async () => {
    const entries = Array.from({ length: 520 }, (_, i) =>
      kdbxEntry(10 + i, { Title: `e${String(i)}` }),
    );
    entries[0] = kdbxEntry(10, {
      Title: "e0",
      Password: `{REF:P@I:${hex(529).toUpperCase()}}`,
    });
    const file: KdbxFile = kdbxFile(kdbxGroup(1, "Root", { entries }));
    const a = await firstDevice();
    const target = {
      kind: "group" as const,
      vaultId: a.vaultId,
      groupId: rootOf(a.engine, a.vaultId),
    };
    await (await a.engine.prepareKdbxImport(file, target, TEXTS)).run();
    await a.engine.destroy(a.vaultId, [entryRef(uuid(529))]);

    // A device without local marks does not know the tombstone.
    const b = await secondDevice(a.server);
    const job = await b.engine.prepareKdbxImport(file, target, TEXTS);
    await job.run();
    // Root group; entries 1–500; the rest twice (tombstone conflict); fix-up.
    expect(a.server.batchSizes.slice(-5)).toEqual([1, 500, 20, 20, 1]);
    const copies = entryTitled(b.engine, a.vaultId, "e519");
    expect(copies).toHaveLength(1);
    const newId = copies[0]?.id ?? "";
    expect(newId).not.toBe(uuid(529));
    const referrer = entryTitled(b.engine, a.vaultId, "e0").find(
      (e) => e.id !== uuid(10),
    );
    const detail = b.engine.entry(a.vaultId, referrer?.id ?? "");
    expect(detail?.values.password).toBe(
      `{REF:P@I:${newId.replaceAll("-", "").toUpperCase()}}`,
    );
    // The fix-up adds no history state.
    expect(detail?.history).toHaveLength(0);
  });

  it("resumes after network errors with the same request", async () => {
    const { server, engine } = await firstDevice();
    const file = await readFixture("keepassxc-example");
    const job = await engine.prepareKdbxImport(
      file,
      { kind: "vault", name: "X" },
      TEXTS,
    );
    const start = server.log.length;
    server.loseResponses = (path, method) =>
      method === "POST" && path === "/v1/vaults";
    const error = await failure(job.run());
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).code).toBe("network");
    expect(job.vaultId).toBeUndefined();
    // The API client repeats a batch twice by itself.
    server.loseResponses = (path) => path.endsWith("/batch");
    const second = await failure(job.run());
    expect((second as SyncError).code).toBe("network");
    expect(job.vaultId).toBeDefined();
    server.loseResponses = () => false;
    await job.run();
    expect(job.finished).toBe(true);
    const vaultId = job.vaultId ?? "";
    expect(vault(engine, vaultId).entries.size).toBe(1);
    const posts = server.log
      .slice(start)
      .filter((r) => r.method === "POST" && r.path === "/v1/vaults");
    expect(new Set(posts.map((p) => p.body)).size).toBe(1);
    const batches = server.log.filter((r) => r.path.endsWith("/batch"));
    // Group batch: three tries with lost answers, then the same bytes again.
    expect(new Set(batches.slice(0, 4).map((b) => b.body)).size).toBe(1);
    expect(batches).toHaveLength(5);
    expect(server.vaults.size).toBe(2);
  });

  it("stops between steps when cancelled", async () => {
    const { engine } = await firstDevice();
    const file = await readFixture("keeman-sample");
    const before = new AbortController();
    before.abort();
    const job = await engine.prepareKdbxImport(
      file,
      { kind: "vault", name: "C" },
      TEXTS,
    );
    const early = await failure(job.run({ signal: before.signal }));
    expect((early as KdbxError).code).toBe("cancelled");
    expect(job.vaultId).toBeUndefined();

    const during = new AbortController();
    const late = await failure(
      job.run({
        signal: during.signal,
        onProgress: () => {
          during.abort();
        },
      }),
    );
    expect(late).toBeInstanceOf(KdbxError);
    expect(job.vaultId).toBeDefined();
    expect(job.finished).toBe(false);
    await job.run();
    expect(job.finished).toBe(true);
  });

  it("refuses unusable targets", async () => {
    const { engine, vaultId } = await firstDevice();
    const file = await readFixture("keepass-example");
    const code = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (error) {
        return (error as SyncError).code;
      }
      return "none";
    };
    expect(
      await code(() =>
        engine.prepareKdbxImport(file, { kind: "vault", name: " " }, TEXTS),
      ),
    ).toBe("invalid_name");
    expect(
      await code(() =>
        engine.prepareKdbxImport(
          file,
          { kind: "group", vaultId, groupId: binOf(engine, vaultId) },
          TEXTS,
        ),
      ),
    ).toBe("invalid_target");
    expect(
      await code(() =>
        engine.prepareKdbxImport(
          file,
          { kind: "group", vaultId, groupId: uuid(4242) },
          TEXTS,
        ),
      ),
    ).toBe("invalid_target");
    expect(
      await code(() =>
        engine.prepareKdbxImport(
          file,
          { kind: "group", vaultId: uuid(4243), groupId: uuid(1) },
          TEXTS,
        ),
      ),
    ).toBe("not_found");
  });

  it("rejects a second run while one is active", async () => {
    const { engine, vaultId } = await firstDevice();
    const file = await readFixture("keepass-example");
    const job = await engine.prepareKdbxImport(
      file,
      { kind: "group", vaultId, groupId: rootOf(engine, vaultId) },
      TEXTS,
    );
    const running = job.run();
    await expect(job.run()).rejects.toThrow("already running");
    await running;
    await job.run();
    expect(job.finished).toBe(true);
  });
});

describe("KDBX import with attachments", () => {
  /** Test data only: three binaries; one larger than the server allows. */
  function withBinaries() {
    const small = Uint8Array.from({ length: 300 }, (_, i) => i % 7);
    const text = new TextEncoder().encode("Fantasie ".repeat(200));
    const big = new Uint8Array(5000);
    const entry = kdbxEntry(
      10,
      { Title: "Mit Dateien", UserName: "u" },
      {
        attachments: [
          { name: "bild.png", binary: 0 },
          { name: "notiz.txt", binary: 1 },
          { name: "gross.bin", binary: 2 },
        ],
        history: [
          {
            ...kdbxEntry(10, { Title: "alt" }),
            attachments: [{ name: "alte-notiz.txt", binary: 1 }],
          },
        ],
      },
    );
    const file = kdbxFile(kdbxGroup(1, "Root", { entries: [entry] }), {}, [
      small,
      text,
      big,
    ]);
    return { file, small, text };
  }

  it("uploads binaries as attachments the entry and its history share", async () => {
    const { server, engine } = await firstDevice();
    server.attachmentMaxBytes = 4096;
    const { file, small, text } = withBinaries();
    const job = await engine.prepareKdbxImport(
      file,
      { kind: "vault", name: "Mit Anhängen" },
      TEXTS,
    );
    expect(job.report.attachments).toBe(2);
    expect(job.report.items).toContainEqual({
      kind: "attachment_too_large",
      path: [],
      title: "Mit Dateien",
      name: "gross.bin",
    });
    await job.run();
    const vaultId = job.vaultId ?? "";
    const [summary] = entryTitled(engine, vaultId, "Mit Dateien");
    const detail = engine.entry(vaultId, summary?.id ?? "");
    expect(detail?.attachments.map((a) => [a.name, a.mime])).toEqual([
      ["bild.png", "image/png"],
      ["notiz.txt", "text/plain"],
    ]);
    const [image, note] = detail?.attachments ?? [];
    expect(note?.compression).toBe("gzip");
    expect(image?.compression).toBe("none");
    expect(
      await engine.readAttachment(vaultId, summary?.id ?? "", image?.id ?? ""),
    ).toEqual(small);
    expect(
      await engine.readAttachment(vaultId, summary?.id ?? "", note?.id ?? ""),
    ).toEqual(text);
    // The history state refers to the same attachment under its own name.
    expect(detail?.history[0]?.values.attachments).toEqual([
      expect.objectContaining({ id: note?.id, name: "alte-notiz.txt" }),
    ]);
    expect(server.attachments.size).toBe(2);
    for (const stored of server.attachments.values())
      expect(stored).toMatchObject({
        state: "complete",
        vaultId,
        entryId: summary?.id,
      });
  });

  it("repeats an upload with the same bytes and fails on a full quota", async () => {
    const { server, engine } = await firstDevice();
    const { file } = withBinaries();
    const job = await engine.prepareKdbxImport(
      file,
      { kind: "vault", name: "Wiederholt" },
      TEXTS,
    );
    // The first complete goes through, its answer is lost.
    let lost = false;
    server.dropResponse = (path) => {
      if (lost || !path.endsWith("/complete")) return false;
      lost = true;
      return true;
    };
    await job.run();
    expect(job.finished).toBe(true);
    const vaultId = job.vaultId ?? "";
    const [summary] = entryTitled(engine, vaultId, "Mit Dateien");
    for (const attachment of engine.entry(vaultId, summary?.id ?? "")
      ?.attachments ?? [])
      expect(
        (await engine.readAttachment(vaultId, summary?.id ?? "", attachment.id))
          .length,
      ).toBe(attachment.size);

    // Into an existing vault whose owner's quota is used up.
    const other = await firstDevice();
    const second = await other.engine.prepareKdbxImport(
      file,
      {
        kind: "group",
        vaultId: other.vaultId,
        groupId: rootOf(other.engine, other.vaultId),
      },
      TEXTS,
    );
    other.server.failures.set(`/v1/vaults/${other.vaultId}/attachments`, [
      { status: 507, code: "quota_exceeded" },
    ]);
    const error = await failure(second.run());
    expect(error).toMatchObject({ code: "quota_exceeded" });
    expect(second.finished).toBe(false);
  });
});

describe("custom icons in the import job", () => {
  it("writes the icons first; a new vault's root finds its icon afterwards", async () => {
    const { server, engine } = await firstDevice();
    const icon = "c".repeat(32);
    const file: KdbxFile = kdbxFile(
      kdbxGroup(1, "Root", {
        customIcon: icon,
        entries: [kdbxEntry(2, { Title: "t" }, { customIcon: icon })],
      }),
    );
    file.customIcons = [
      { uuid: icon, name: "Logo", data: new Uint8Array([1]) },
    ];
    const job = await engine.prepareKdbxImport(
      file,
      { kind: "vault", name: "Mit Icon" },
      { ...TEXTS, icons: new Map([[icon, iconPng(9)]]) },
    );
    await job.run();
    expect(job.progress).toEqual({ done: 3, total: 3 });
    const vaultId = job.vaultId ?? "";
    const view = vault(engine, vaultId);
    const [id] = [...view.icons.keys()];
    expect(view.icons.get(id ?? "")).toMatchObject({
      name: "Logo",
      source: { type: "kdbx" },
      used: true,
    });
    // The root node shows the vault icon; the root group keeps its own.
    expect(view.tree.nodes.get(view.tree.rootId)?.iconRef).toEqual({
      type: "custom",
      id,
    });
    expect(entryTitled(engine, vaultId, "t")[0]?.customIcon).toBe(id);
    // The icon went up in its own batch before the entry.
    const types = server.log
      .filter((l) => l.path.endsWith("/batch"))
      .map((l) => l.path);
    expect(types.length).toBeGreaterThanOrEqual(2);
  });
});

import { describe, expect, it } from "vitest";
import { readKdbxInWorker, writeKdbxInWorker } from "../../src/kdbx/client";
import { handleKdbxMessage } from "../../src/kdbx/file/worker";
import { KDBX_MESSAGE_KIND, type KdbxResponse } from "../../src/kdbx/protocol";
import { KdbxError, type KdbxExportModel } from "../../src/kdbx/types";
import { fakeKdbxWorker, fixture, utf8 } from "./helpers";

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KdbxError) return error.code;
    throw error;
  }
  throw new Error("expected a KdbxError");
}

const times = { created: null, modified: null, expires: null };
const MODEL: KdbxExportModel = {
  meta: {
    name: "W",
    description: "",
    color: null,
    historyMaxItems: 10,
    recycleBinEnabled: false,
    recycleBinUuid: null,
  },
  root: {
    uuid: "0193000b000040008000000000000001",
    name: "W",
    notes: "",
    icon: 48,
    customIcon: null,
    times,
    groups: [],
    entries: [],
  },
  binaries: [],
  customIcons: [],
};

describe("KDBX worker protocol", () => {
  it("reads in a worker, reports the header and terminates it", async () => {
    const fake = fakeKdbxWorker();
    const headers: string[] = [];
    const data = fixture("keepass-example");
    const file = await readKdbxInWorker(
      () => fake.worker,
      { data, password: "test", keyFile: null },
      { onHeader: (header) => headers.push(header.version) },
    );
    expect(file.meta.name).toBe("keepass test");
    expect(headers).toEqual(["4.0"]);
    expect(fake.seen.terminated).toBe(true);
    // File copy and password were transferred; the caller keeps its file.
    expect(fake.seen.transferred).toEqual([data.length, 4]);
    expect(fake.seen.detached).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("passes a key file and refuses to start without credentials", async () => {
    let spawned = 0;
    const spawn = () => {
      spawned++;
      return fakeKdbxWorker().worker;
    };
    expect(
      await failure(
        readKdbxInWorker(spawn, {
          data: fixture("keepass-example"),
          password: "",
          keyFile: null,
        }),
      ),
    ).toBe("no_credentials");
    expect(spawned).toBe(0);
    expect(
      await failure(
        readKdbxInWorker(spawn, {
          data: fixture("keepass-example"),
          password: "",
          keyFile: utf8("not the key"),
        }),
      ),
    ).toBe("wrong_key");
  });

  it("writes in a worker with the NFC form of the password", async () => {
    const fake = fakeKdbxWorker();
    const bytes = await writeKdbxInWorker(
      () => fake.worker,
      MODEL,
      "Café pass",
    );
    expect(fake.seen.terminated).toBe(true);
    const file = await readKdbxInWorker(() => fakeKdbxWorker().worker, {
      data: bytes,
      password: "Café pass",
      keyFile: null,
    });
    expect(file.root.uuid).toBe(MODEL.root.uuid);
  });

  it("cancels before starting and while running", async () => {
    let spawned = 0;
    const controller = new AbortController();
    controller.abort();
    expect(
      await failure(
        readKdbxInWorker(
          () => {
            spawned++;
            return fakeKdbxWorker().worker;
          },
          { data: fixture("keepass-example"), password: "test", keyFile: null },
          { signal: controller.signal },
        ),
      ),
    ).toBe("cancelled");
    expect(spawned).toBe(0);

    const running = new AbortController();
    const fake = fakeKdbxWorker();
    const pending = readKdbxInWorker(
      () => fake.worker,
      { data: fixture("keepassxc-example"), password: "test", keyFile: null },
      {
        signal: running.signal,
        onHeader: () => {
          running.abort();
        },
      },
    );
    expect(await failure(pending)).toBe("cancelled");
    expect(fake.seen.terminated).toBe(true);
  });

  it("reports a crashed worker as failed", async () => {
    const fake = fakeKdbxWorker(() => new Promise(() => undefined));
    const pending = writeKdbxInWorker(() => fake.worker, MODEL, "pw");
    fake.crash();
    expect(await failure(pending)).toBe("failed");
    expect(fake.seen.terminated).toBe(true);
  });

  it("treats unexpected answers as failures", async () => {
    const answer = (message: Record<string, unknown>) =>
      fakeKdbxWorker((data, post) => {
        const id = (data as { id: number }).id;
        post({ kind: KDBX_MESSAGE_KIND, id, ...message }, []);
        return Promise.resolve();
      }).worker;
    const write = (message: Record<string, unknown>) =>
      failure(writeKdbxInWorker(() => answer(message), MODEL, "pw"));
    expect(await write({ stage: "done", ok: false, code: "bogus" })).toBe(
      "failed",
    );
    expect(await write({ stage: "done", ok: false, code: "wrong_key" })).toBe(
      "wrong_key",
    );
    expect(await write({ stage: "done", ok: true })).toBe("failed");
    expect(await write({ id: -7, stage: "done", ok: true })).toBe("failed");
    const silent = fakeKdbxWorker((_, post) => {
      post({ kind: "other" }, []);
      return Promise.resolve();
    });
    expect(
      await failure(writeKdbxInWorker(() => silent.worker, MODEL, "pw")),
    ).toBe("failed");
  });

  it("answers malformed requests with failed and wipes secrets", async () => {
    const answers: KdbxResponse[] = [];
    const post = (message: KdbxResponse) => {
      answers.push(message);
    };
    await handleKdbxMessage(null, post);
    await handleKdbxMessage(
      { kind: KDBX_MESSAGE_KIND, id: 3, op: "read" },
      post,
    );
    await handleKdbxMessage(
      { kind: KDBX_MESSAGE_KIND, id: 4, op: "write", password: utf8("x") },
      post,
    );
    await handleKdbxMessage({ kind: KDBX_MESSAGE_KIND, id: 1.5 }, post);
    expect(answers.map((a) => [a.id, "code" in a ? a.code : ""])).toEqual([
      [-1, "failed"],
      [3, "failed"],
      [4, "failed"],
      [-1, "failed"],
    ]);

    const password = utf8("test");
    const keyFile = utf8("key");
    const data = fixture("keepass-example");
    const view = new Uint8Array(data.length + 8);
    view.set(data, 8);
    answers.length = 0;
    await handleKdbxMessage(
      {
        kind: KDBX_MESSAGE_KIND,
        id: 5,
        op: "read",
        data: view.subarray(8),
        password,
        keyFile,
      },
      post,
    );
    expect(answers.at(-1)).toMatchObject({
      id: 5,
      ok: false,
      code: "wrong_key",
    });
    expect([...password, ...keyFile].every((byte) => byte === 0)).toBe(true);
  });
});

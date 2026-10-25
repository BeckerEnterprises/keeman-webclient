import { describe, expect, it } from "vitest";
import { deriveLoginKeys } from "../../src/crypto/argon2";
import {
  ARGON2_MESSAGE_KIND,
  deriveLoginKeysInWorker,
  handleArgon2Message,
  type WorkerLike,
} from "../../src/crypto/argon2-worker";
import { utf8Encode } from "../../src/crypto/bytes";
import { MIN_KDF, tv } from "../helpers";

const salt = tv("worker-salt", 16);

/** A worker built on MessageChannel, so transfers behave like in a browser. */
function fakeWorker(
  handle: (data: unknown) => Promise<{
    response: unknown;
    transfer: ArrayBuffer[];
  }> = handleArgon2Message,
) {
  const channel = new MessageChannel();
  const seen: { passwordDetached?: boolean; terminated: boolean } = {
    terminated: false,
  };
  channel.port2.onmessage = (event: MessageEvent) => {
    void handle(event.data).then(({ response, transfer }) => {
      channel.port2.postMessage(response, transfer);
    });
  };
  const worker: WorkerLike = {
    postMessage: (message, transfer) => {
      channel.port1.postMessage(message, transfer);
      seen.passwordDetached =
        (message as { password: Uint8Array }).password.byteLength === 0;
    },
    addEventListener: (
      type: "message" | "error",
      listener: (event: { data?: unknown }) => void,
    ) => {
      if (type === "message")
        channel.port1.onmessage = (event: MessageEvent) => {
          listener({ data: event.data });
        };
    },
    terminate: () => {
      seen.terminated = true;
      channel.port1.close();
      channel.port2.close();
    },
  };
  return { worker, seen };
}

describe("Argon2 worker protocol", () => {
  it("derives the same keys as in-thread and transfers the password", async () => {
    const { worker, seen } = fakeWorker();
    const keys = await deriveLoginKeysInWorker(
      () => worker,
      "Grüße",
      salt,
      MIN_KDF,
    );
    expect(keys).toEqual(deriveLoginKeys("Grüße", salt, MIN_KDF));
    expect(seen.terminated).toBe(true);
    expect(seen.passwordDetached).toBe(true);
  });

  it("answers invalid requests without deriving", async () => {
    await expect(handleArgon2Message(null)).resolves.toMatchObject({
      response: { ok: false, code: "validation", id: -1 },
    });
    await expect(
      handleArgon2Message({ kind: ARGON2_MESSAGE_KIND, id: 4 }),
    ).resolves.toMatchObject({
      response: { ok: false, code: "validation", id: 4 },
    });
    const badParams = {
      kind: ARGON2_MESSAGE_KIND,
      id: 5,
      password: utf8Encode("pw"),
      salt,
      kdf: { ...MIN_KDF, ops: 1 },
    };
    await expect(handleArgon2Message(badParams)).resolves.toMatchObject({
      response: { ok: false, code: "validation" },
    });
    expect(badParams.password).toEqual(new Uint8Array(2));
    const badSalt = {
      kind: ARGON2_MESSAGE_KIND,
      id: 6,
      password: utf8Encode("pw"),
      salt: new Uint8Array(3),
      kdf: MIN_KDF,
    };
    await expect(handleArgon2Message(badSalt)).resolves.toMatchObject({
      response: { ok: false, code: "validation" },
    });
  });

  it("maps worker failures to errors and always terminates", async () => {
    const reply = (response: unknown) =>
      fakeWorker(() => Promise.resolve({ response, transfer: [] }));
    const cases: [unknown, RegExp | "validation"][] = [
      [{ kind: ARGON2_MESSAGE_KIND, id: -99, ok: true }, /Unexpected answer/],
      [{ kind: "other" }, /Unexpected answer/],
      [null, /Unexpected answer/],
      [
        { kind: ARGON2_MESSAGE_KIND, ok: false, code: "internal" },
        /worker failed/,
      ],
      [
        { kind: ARGON2_MESSAGE_KIND, ok: false, code: "validation" },
        "validation",
      ],
      [
        {
          kind: ARGON2_MESSAGE_KIND,
          ok: true,
          authKey: new Uint8Array(1),
          wrapKey: new Uint8Array(32),
        },
        /Unexpected answer/,
      ],
    ];
    for (const [response, expected] of cases) {
      const fake = reply(response);
      // Echo the request id where the case does not set its own.
      const worker: WorkerLike = {
        ...fake.worker,
        addEventListener: (
          type: "message" | "error",
          listener: (event: { data?: unknown }) => void,
        ) => {
          fake.worker.addEventListener(type, (event) => {
            const data = event.data as Record<string, unknown> | null;
            listener({
              data:
                data && data.id === undefined
                  ? { ...data, id: requestId }
                  : data,
            });
          });
        },
        postMessage: (message, transfer) => {
          requestId = (message as { id: number }).id;
          fake.worker.postMessage(message, transfer);
        },
      };
      let requestId = 0;
      const run = deriveLoginKeysInWorker(() => worker, "pw", salt, MIN_KDF);
      if (expected === "validation") {
        await expect(run).rejects.toMatchObject({ code: "validation" });
      } else {
        await expect(run).rejects.toThrow(expected);
      }
      expect(fake.seen.terminated).toBe(true);
    }
  });

  it("rejects on worker errors and invalid input before spawning", async () => {
    let terminated = false;
    const failing: WorkerLike = {
      postMessage: () => undefined,
      addEventListener: (
        type: "message" | "error",
        listener: (event: { data?: unknown }) => void,
      ) => {
        if (type === "error")
          queueMicrotask(() => {
            listener({});
          });
      },
      terminate: () => {
        terminated = true;
      },
    };
    await expect(
      deriveLoginKeysInWorker(() => failing, "pw", salt, MIN_KDF),
    ).rejects.toThrow(/worker failed/);
    expect(terminated).toBe(true);
    await expect(
      deriveLoginKeysInWorker(() => failing, "pw", new Uint8Array(15), MIN_KDF),
    ).rejects.toMatchObject({
      code: "validation",
    });
  });
});

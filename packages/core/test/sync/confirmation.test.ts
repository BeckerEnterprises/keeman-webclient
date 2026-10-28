/**
 * Confirmation by another device of the account: a request bound to a
 * nonce, a signed answer, and what the server cannot fake, replay or
 * redirect.
 */
import { describe, expect, it } from "vitest";
import { toBase64Url } from "../../src/crypto/bytes";
import { tv } from "../../src/crypto/internal/test-values";
import { stateCodeOf } from "../../src/crypto/state-code";
import { inMemorySyncMarks } from "../../src/sync/marks";
import { FakeServer } from "../account/fake-server";
import { vault } from "./devices";
import { another, Clock, DAY, first, withhold } from "./freshness-devices";

type Device = Awaited<ReturnType<typeof another>>;

/** The only open request of another session, as `confirmer` sees it. */
async function requestOf(confirmer: Device): Promise<string> {
  const [request, ...more] = await confirmer.account.confirmationRequests();
  if (!request || more.length > 0) throw new Error("expected one request");
  return request.requestId;
}

/** The stored answer of a request, before the requester deletes it. */
function answerOf(server: FakeServer, requestId: string) {
  const answer = server.confirmations.get(requestId)?.answer;
  if (!answer) throw new Error("no answer");
  return answer;
}

describe("a confirmation by another device", () => {
  it("hands the marks and confirmation times to a new device", async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    expect(vault(b.engine, a.vaultId).freshness).toBe("stale");
    expect(b.account.isNewDevice).toBe(true);
    expect(await b.account.checkConfirmation()).toEqual({ status: "none" });

    const { expiresAt } = await b.account.requestConfirmation();
    expect(expiresAt).toBe(a.clock.t + 300_000);
    expect(b.account.confirmationDeadline).toBe(expiresAt);
    // The requester does not see its own request as one to confirm.
    expect(await b.account.confirmationRequests()).toEqual([]);
    const [request] = await a.account.confirmationRequests();
    expect(request).toMatchObject({
      deviceName: "Test · Node",
      clientType: "web",
    });
    // The remaining time of the server, counted on this device's clock.
    expect(request?.expiresAt).toBeGreaterThan(a.clock.t + 290_000);
    expect(request?.expiresAt).toBeLessThanOrEqual(a.clock.t + 300_000);
    expect(await b.account.checkConfirmation()).toEqual({ status: "waiting" });

    await a.account.confirmRequest(request?.requestId ?? "");
    expect(await b.account.checkConfirmation()).toEqual({
      status: "confirmed",
      vaults: 1,
      confirmed: 1,
      missing: 0,
    });
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      freshness: "fresh",
      writable: true,
    });
    expect(b.account.userDataStale).toBe(false);
    expect(b.account.isNewDevice).toBe(false);
    expect(a.server.confirmations.size).toBe(0);
    expect(b.account.confirmationDeadline).toBeUndefined();
  });

  it("is taken neither from another account, nor replayed, nor for another nonce or request", async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    const c = await another(a.server, a.clock);

    // The answer to another device's request.
    await c.account.requestConfirmation();
    const forC = await requestOf(a);
    await a.account.confirmRequest(forC);
    const answerForC = answerOf(a.server, forC);
    await b.account.requestConfirmation();
    a.server.tamperConfirmation = (status) => {
      status.answer = answerForC;
    };
    await expect(b.account.checkConfirmation()).rejects.toMatchObject({
      code: "confirmation_invalid",
    });
    expect(vault(b.engine, a.vaultId).freshness).toBe("stale");

    // The own earlier answer, replayed for a new request.
    a.server.tamperConfirmation = () => undefined;
    await b.account.requestConfirmation();
    const earlier = (await a.account.confirmationRequests()).find(
      (r) => r.requestId !== forC,
    );
    await a.account.confirmRequest(earlier?.requestId ?? "");
    const replayed = answerOf(a.server, earlier?.requestId ?? "");
    await b.account.requestConfirmation();
    a.server.tamperConfirmation = (status) => {
      status.answer = replayed;
    };
    await expect(b.account.checkConfirmation()).rejects.toMatchObject({
      code: "confirmation_invalid",
    });

    // A lying server shows the confirming device a nonce of its own: the
    // answer is signed for it, not for the one the requester keeps.
    a.server.tamperConfirmation = () => undefined;
    await b.account.requestConfirmation();
    const shown = await requestOf(a);
    const stored = a.server.confirmations.get(shown);
    if (!stored) throw new Error("no request");
    const kept = stored.nonce;
    stored.nonce = toBase64Url(tv("server nonce", 32));
    await a.account.confirmRequest(shown);
    stored.nonce = kept;
    await expect(b.account.checkConfirmation()).rejects.toMatchObject({
      code: "confirmation_invalid",
    });

    // An answer by another account's key.
    const other = await first(new FakeServer(), a.clock);
    const otherDevice = await another(other.server, a.clock);
    await otherDevice.account.requestConfirmation();
    const foreignId = await requestOf(other);
    await other.account.confirmRequest(foreignId);
    const foreign = answerOf(other.server, foreignId);
    await b.account.requestConfirmation();
    a.server.tamperConfirmation = (status) => {
      status.answer = foreign;
    };
    await expect(b.account.checkConfirmation()).rejects.toMatchObject({
      code: "confirmation_invalid",
    });

    // A changed statement under a valid signature.
    a.server.tamperConfirmation = () => undefined;
    await b.account.requestConfirmation();
    const last = (await a.account.confirmationRequests())[0];
    await a.account.confirmRequest(last?.requestId ?? "");
    const genuine = answerOf(a.server, last?.requestId ?? "");
    a.server.tamperConfirmation = (status) => {
      status.answer = {
        ...genuine,
        statement: `${genuine.statement.slice(0, -2)}${genuine.statement.endsWith("A") ? "B" : "A"}${genuine.statement.slice(-1)}`,
      };
    };
    await expect(b.account.checkConfirmation()).rejects.toMatchObject({
      code: "confirmation_invalid",
    });
    expect(vault(b.engine, a.vaultId).freshness).toBe("stale");
    // A rejected answer ends the request.
    expect(b.account.confirmationDeadline).toBeUndefined();
  });

  it("leaves the device stale while the server withholds the answer, until its own deadline", async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    // A server that keeps the request open beyond its time.
    a.server.confirmationTtlMs = 86_400_000;
    await b.account.requestConfirmation();
    await a.account.confirmRequest(await requestOf(a));
    a.server.tamperConfirmation = (status) => {
      status.answer = null;
    };
    expect(await b.account.checkConfirmation()).toEqual({ status: "waiting" });
    a.clock.advance(301_000);
    await expect(b.account.checkConfirmation()).rejects.toMatchObject({
      code: "confirmation_expired",
    });
    expect(vault(b.engine, a.vaultId).freshness).toBe("stale");
  });

  it("tells a second confirming device it came too late; a repeat sends the same bytes", async () => {
    const a = await first();
    withhold(a.server);
    const a2 = await another(a.server, a.clock);
    const b = await another(a.server, a.clock);
    await b.account.requestConfirmation();
    const id = await requestOf(a);
    a.server.failures.set(`/v1/me/confirmations/${id}`, [
      { status: 503, code: "internal_error" },
    ]);
    await a.account.confirmRequest(id);
    const puts = a.server.log.filter(
      (r) => r.method === "PUT" && r.path === `/v1/me/confirmations/${id}`,
    );
    expect(puts.length).toBe(2);
    expect(puts[0]?.body).toBe(puts[1]?.body);
    // Gone from the list of open requests once answered.
    expect(await a2.account.confirmationRequests()).toEqual([]);
    await expect(a2.account.confirmRequest(id)).rejects.toMatchObject({
      code: "confirmation_answered",
    });
    expect(await b.account.checkConfirmation()).toMatchObject({
      status: "confirmed",
      confirmed: 1,
    });
  });

  it("is refused for a request that is no longer open", async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    await b.account.requestConfirmation();
    const id = await requestOf(a);
    // The requester asks anew while the confirming device syncs.
    a.server.onRequest = (method, path) => {
      if (method === "GET" && path === "/v1/vaults") {
        a.server.onRequest = () => undefined;
        void b.account.requestConfirmation();
      }
    };
    await expect(a.account.confirmRequest(id)).rejects.toMatchObject({
      code: "confirmation_missing",
    });
  });

  it("passes floors but no confirmation time for vaults the confirming device would not sign", async () => {
    const a = await first();
    withhold(a.server);
    const c = await another(a.server, a.clock);
    const b = await another(a.server, a.clock);
    expect(vault(c.engine, a.vaultId).freshness).toBe("stale");
    expect(c.account.unconfirmableVaults).toBe(1);
    expect(a.account.unconfirmableVaults).toBe(0);
    await b.account.requestConfirmation();
    await c.account.confirmRequest(await requestOf(c));
    const marks = await b.marks.read(b.account.userId ?? "");
    expect(await b.account.checkConfirmation()).toEqual({
      status: "confirmed",
      vaults: 1,
      confirmed: 0,
      missing: 0,
    });
    expect(vault(b.engine, a.vaultId).freshness).toBe("stale");
    expect(marks.vaults[a.vaultId]?.ft ?? 0).toBe(0);
    expect(
      (await b.marks.read(b.account.userId ?? "")).vaults[a.vaultId]?.ft ?? 0,
    ).toBe(0);
  });

  it("carries comparison points, and a fork its roles point reveals outlasts a lock", async () => {
    const a = await first();
    withhold(a.server);
    const userId = a.account.userId ?? "";
    // The confirming device saw another statement at the head's version.
    const head = vault(a.engine, a.vaultId).roles.code?.version ?? 1;
    const forked = toBase64Url(tv("forked head", 32));
    await a.marks.replaceRoles(userId, a.vaultId, [head, forked]);
    await a.engine.refresh();
    expect(vault(a.engine, a.vaultId).roles.status).toBe("fork");
    expect(a.account.unconfirmableVaults).toBe(1);

    const marks = inMemorySyncMarks();
    const b = await another(a.server, a.clock, marks);
    await b.account.requestConfirmation();
    await a.account.confirmRequest(await requestOf(a));
    await b.account.checkConfirmation();
    expect(vault(b.engine, a.vaultId)).toMatchObject({
      roles: { status: "fork" },
      writable: false,
    });
    // A device with a warning passes on no confirmation time.
    const taken = await marks.read(b.account.userId ?? "");
    expect(taken.vaults[a.vaultId]?.ft ?? 0).toBe(0);

    // Kept as a comparison point, the fork outlasts the lock.
    b.account.lock();
    const again = await another(a.server, a.clock, marks);
    const roles = vault(again.engine, a.vaultId).roles;
    expect(roles.status).toBe("fork");
    expect(roles.compared?.code.code).toBe(stateCodeOf(forked));
  });

  it("settles a roles point the chain satisfies", async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    await b.account.requestConfirmation();
    await a.account.confirmRequest(await requestOf(a));
    await b.account.checkConfirmation();
    expect(vault(b.engine, a.vaultId).roles.status).toBe("ok");
    const stored = await b.marks.read(b.account.userId ?? "");
    expect(stored.vaults[a.vaultId]?.cp ?? []).toEqual([]);
  });

  it("ends quietly when another tab of the session asked anew, without deleting its request", async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    await b.account.requestConfirmation();
    const mine = [...a.server.confirmations.values()][0];
    if (!mine) throw new Error("no request");
    // Another tab of the same session replaces the request.
    a.server.confirmations.delete(mine.id);
    a.server.confirmations.set("0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5c99", {
      ...mine,
      id: "0192b3a4-5c6d-7e8f-9a0b-1c2d3e4f5c99",
      nonce: toBase64Url(tv("other tab", 32)),
    });
    expect(await b.account.checkConfirmation()).toEqual({
      status: "replaced",
    });
    expect(a.server.confirmations.size).toBe(1);
    expect(b.account.confirmationDeadline).toBeUndefined();
  });

  it('is declined with "that wasn\'t me"', async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    await b.account.requestConfirmation();
    await a.account.declineRequest(await requestOf(a));
    expect(a.server.confirmations.size).toBe(0);
    await expect(b.account.checkConfirmation()).rejects.toMatchObject({
      code: "confirmation_missing",
    });
  });

  it("ends with locked when a lock overtakes it, and a lock drops the request", async () => {
    const a = await first();
    withhold(a.server);
    const b = await another(a.server, a.clock);
    await b.account.requestConfirmation();
    await a.account.confirmRequest(await requestOf(a));
    a.server.onRequest = (method, path) => {
      if (method === "GET" && path.startsWith("/v1/me/confirmations/"))
        b.account.lock();
    };
    await expect(b.account.checkConfirmation()).rejects.toMatchObject({
      code: "locked",
    });
    expect(b.account.confirmationDeadline).toBeUndefined();
    const marks = await b.marks.read(b.account.userId ?? "");
    expect(marks.vaults[a.vaultId]?.ft ?? 0).toBe(0);
  });

  it("is not offered by a server without confirmations", async () => {
    const server = new FakeServer();
    server.confirmationEnabled = false;
    const a = await first(server);
    const b = await another(server, a.clock);
    await expect(b.account.requestConfirmation()).rejects.toMatchObject({
      code: "confirmation_unsupported",
    });
    expect(await a.account.confirmationRequests()).toEqual([]);
    expect(await b.account.confirmationSupported()).toBe(false);
  });

  it("caps confirmation times from the future at the own clock", async () => {
    const clock = new Clock();
    const a = await first(new FakeServer(), clock);
    withhold(a.server);
    const b = await another(a.server, clock);
    await b.account.requestConfirmation();
    await a.account.confirmRequest(await requestOf(a));
    // The requester's clock is a day behind: the answer's times lie ahead.
    clock.advance(-DAY);
    await b.account.checkConfirmation();
    const marks = await b.marks.read(b.account.userId ?? "");
    expect(marks.vaults[a.vaultId]?.ft).toBe(clock.t);
  });
});

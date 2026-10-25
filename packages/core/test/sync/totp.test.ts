import { describe, expect, it } from "vitest";
import { emptyDraft } from "../../src/model/entry";
import { totpFromUri } from "../../src/totp/code";
import { kdbxEntry, kdbxFile, kdbxGroup } from "../kdbx/helpers";
import { firstDevice, rootOf, secondDevice, vault } from "./devices";

const URI = "otpauth://totp/Mail:me?secret=jbswy3dpehpk3pxp&digits=8";
const NORMALIZED = "otpauth://totp/Mail:me?secret=JBSWY3DPEHPK3PXP&digits=8";

/** Waits until the clock of a fresh engine has measured. */
async function settled(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("TOTP in the engine", () => {
  it("computes codes in the core and shows only the status in summaries", async () => {
    const { engine, vaultId } = await firstDevice();
    const root = rootOf(engine, vaultId);
    const [withTotp = "", nullOtp = "", without = ""] =
      await engine.createEntries(vaultId, root, [
        { ...emptyDraft(), title: "Mail", otp: URI },
        { ...emptyDraft(), title: "Old", otp: null },
        { ...emptyDraft(), title: "None" },
      ]);
    const summaries = vault(engine, vaultId).entries;
    expect(summaries.get(withTotp)?.totp).toBe("ok");
    expect(summaries.get(without)?.totp).toBe("none");
    expect(JSON.stringify(summaries.get(withTotp))).not.toContain("JBSW");
    expect(engine.entry(vaultId, withTotp)?.values.otp).toBe(NORMALIZED);

    const before = engine.serverNow();
    const result = await engine.totp(vaultId, withTotp);
    const after = engine.serverNow();
    const expected = [
      await totpFromUri(NORMALIZED, before),
      await totpFromUri(NORMALIZED, after),
    ];
    expect(expected).toContainEqual(result);
    expect(result).toMatchObject({
      ok: true,
      value: { digits: 8, period: 30 },
    });
    expect(await engine.totp(vaultId, nullOtp)).toBeUndefined();
    expect(await engine.totp(vaultId, "nope")).toBeUndefined();
    expect(
      await engine.totp("0192b3a4-0000-7000-8000-000000000000", withTotp),
    ).toBeUndefined();
  });

  it("reports values v1 cannot use", async () => {
    const { engine, vaultId } = await firstDevice();
    // Only an import keeps such a value; new ones are refused.
    const file = kdbxFile(
      kdbxGroup(1, "Root", {
        entries: [
          kdbxEntry(2, {
            Title: "Counter",
            otp: ["otpauth://hotp/x?secret=MFRGG&counter=3", true],
          }),
        ],
      }),
    );
    await (
      await engine.prepareKdbxImport(
        file,
        { kind: "group", vaultId, groupId: rootOf(engine, vaultId) },
        { emptyFieldName: "Feld" },
      )
    ).run();
    const summary = [...vault(engine, vaultId).entries.values()].find(
      (e) => e.title === "Counter",
    );
    expect(summary?.totp).toBe("unsupported");
    expect(await engine.totp(vaultId, summary?.id ?? "")).toEqual({
      ok: false,
      problem: "hotp",
    });
  });

  it("corrects codes by the server time", async () => {
    const { server, engine, vaultId } = await firstDevice();
    const root = rootOf(engine, vaultId);
    const [mail = ""] = await engine.createEntries(vaultId, root, [
      { ...emptyDraft(), title: "Mail", otp: NORMALIZED },
    ]);
    server.clockSkewMs = 90_000;
    const other = await secondDevice(server);
    await settled(() => other.engine.snapshot.clockOffset !== 0);
    expect(Math.abs(other.engine.snapshot.clockOffset - 90_000)).toBeLessThan(
      2000,
    );
    expect(
      Math.abs(other.engine.serverNow() - Date.now() - 90_000),
    ).toBeLessThan(2000);
    const now = other.engine.serverNow();
    const code = await other.engine.totp(vaultId, mail);
    const options = [
      await totpFromUri(NORMALIZED, now - 2000),
      await totpFromUri(NORMALIZED, now + 2000),
    ];
    expect(options.map((o) => o.ok && o.value.code)).toContain(
      code?.ok === true ? code.value.code : "",
    );
    other.engine.stop();
  });
});

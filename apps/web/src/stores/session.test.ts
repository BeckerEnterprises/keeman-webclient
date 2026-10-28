import { SETTING_DEFAULTS, type UnlockReport } from "@keeman/core";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "./session";

// The store against a stand-in for the core: what matters is which answer
// the store takes over, not how the core derives keys.

const REPORT: UnlockReport = {
  kdfWeakerThanSeen: false,
  kdfBelowDefault: false,
  recoveryKeyUnconfirmed: false,
  userDataCorrupt: false,
  userDataReadOnly: false,
  userDataRollback: false,
  userDataStale: false,
  newDevice: false,
};

const account = {
  isUnlocked: false,
  email: "alice@example.com",
  userId: "0192f000-0000-7000-8000-000000000001",
  kdf: undefined,
  settings: { ...SETTING_DEFAULTS },
  recoveryKeyConfirmed: true,
  userDataState: undefined,
  userDataRollback: false,
  contacts: [],
  ownFingerprint: undefined,
  contactsWritable: false,
  unlock: vi.fn<(password: string) => Promise<UnlockReport>>(),
  updateSettings: vi.fn<(change: object) => Promise<void>>(),
  lock: vi.fn(() => {
    account.isUnlocked = false;
  }),
  startSync: vi.fn<
    (options?: { onSessionEnded?: () => void }) => {
      snapshot: object;
      subscribe: () => () => undefined;
    }
  >(() => ({
    snapshot: {},
    subscribe: () => () => undefined,
  })),
  deleteAccount: vi.fn<(password: string) => Promise<void>>(),
};

vi.mock("../services", () => ({
  useServices: () => ({
    account,
    api: { setAccessToken: vi.fn() },
    tabs: { send: vi.fn() },
  }),
  browserSocket: vi.fn(),
}));

/** An unlock that answers only when the test says so. */
function heldUnlock(): (report: UnlockReport) => void {
  let answer!: (report: UnlockReport) => void;
  account.unlock.mockImplementationOnce(
    () =>
      new Promise<UnlockReport>((resolve) => {
        answer = resolve;
      }),
  );
  return (report) => {
    answer(report);
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  account.isUnlocked = false;
  account.settings = { ...SETTING_DEFAULTS };
  account.unlock.mockReset();
  account.updateSettings.mockReset();
});

describe("session store", () => {
  it("unlocks with the answer of the core", async () => {
    const session = useSessionStore();
    session.phase = "locked";
    account.unlock.mockImplementationOnce(() => {
      account.isUnlocked = true;
      return Promise.resolve(REPORT);
    });
    await session.unlock("password");
    expect(session.phase).toBe("unlocked");
    session.lock(false);
    expect(session.phase).toBe("locked");
  });

  it("stays locked when a lock overtakes an unlock", async () => {
    const session = useSessionStore();
    session.phase = "locked";
    const answer = heldUnlock();
    const unlocking = session.unlock("password");
    // As when another tab sends `lock` while the derivation runs.
    session.lock(false);
    // Even a core that took the late answer does not unlock the view.
    account.isUnlocked = true;
    answer(REPORT);
    await expect(unlocking).rejects.toMatchObject({ code: "locked" });
    expect(session.phase).toBe("locked");
    expect(account.startSync).not.toHaveBeenCalled();
  });

  it("never shows unlocked while the core is locked", async () => {
    const session = useSessionStore();
    session.phase = "locked";
    account.unlock.mockResolvedValueOnce(REPORT);
    await expect(session.unlock("password")).rejects.toMatchObject({
      code: "locked",
    });
    expect(session.phase).toBe("locked");
    expect(() => {
      session.applyUnlocked();
    }).toThrow();
    expect(session.phase).toBe("locked");
  });

  it("takes no settings from a save that a lock overtook", async () => {
    const session = useSessionStore();
    session.phase = "locked";
    account.unlock.mockImplementationOnce(() => {
      account.isUnlocked = true;
      return Promise.resolve(REPORT);
    });
    await session.unlock("password");
    let answer!: () => void;
    account.updateSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    const saving = session.updateSettings({ autoLockMinutes: 5 });
    session.lock(false);
    // Even a core that kept the late answer does not reach the view.
    account.isUnlocked = true;
    account.settings = { ...SETTING_DEFAULTS, autoLockMinutes: 5 };
    answer();
    await expect(saving).rejects.toMatchObject({ code: "locked" });
    expect(session.settings.autoLockMinutes).toBe(
      SETTING_DEFAULTS.autoLockMinutes,
    );
    account.isUnlocked = false;
  });

  it("reports a deleted account, not an expired session, when the server ends it first", async () => {
    const session = useSessionStore();
    session.startSync();
    const options = account.startSync.mock.lastCall?.[0];
    // The server ends this session with the account, before the answer to
    // the deletion arrives.
    account.deleteAccount.mockImplementationOnce(() => {
      const locks = account.lock.mock.calls.length;
      options?.onSessionEnded?.();
      // Like the core: a lock meanwhile ends the deletion with "locked".
      return account.lock.mock.calls.length > locks
        ? Promise.reject(Object.assign(new Error("locked"), { code: "locked" }))
        : Promise.resolve();
    });
    await session.deleteAccount("correct horse battery staple");
    expect(session.notice).toBe("accountDeleted");
  });
});

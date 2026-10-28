/**
 * Phase of the app and what the UI shows about the account. Plain data only:
 * keys, tokens and user_data stay in the core.
 */
import {
  AccountError,
  ApiError,
  NetworkError,
  SETTING_DEFAULTS,
  type Candidate,
  type ContactView,
  type Language,
  type SecondFactorLogin,
  type SecondFactorMethod,
  type Settings,
  type UnlockReport,
} from "@keeman/core";
import { defineStore } from "pinia";
import { toRaw } from "vue";
import { AutoLock } from "../autolock";
import { currentLocale, setLocale } from "../i18n";
import { browserSocket, useServices } from "../services";
import { clearPendingClipboard } from "../clipboard";
import { kdfMemory, viewState } from "../storage";
import { getPasskey } from "../webauthn";
import { useBrowseStore } from "./browse";
import { useConfirmationStore } from "./confirmation";
import { useVaultsStore } from "./vaults";

export type Phase = "starting" | "fatal" | "loggedOut" | "locked" | "unlocked";
export type FatalKind =
  "unreachable" | "config" | "forbidden" | "version" | "crypto" | "integrity";
export type Notice =
  | "expired"
  | "logoutFailed"
  | "accountDeleted"
  | "secondFactorExpired"
  | undefined;

export interface Banners {
  recoveryKeyUnconfirmed: boolean;
  kdfBelowDefault: boolean;
  userDataCorrupt: boolean;
  userDataReadOnly: boolean;
  /** The server delivered older account data. */
  userDataRollback: boolean;
  /** No device of the account confirmed the account data in time. */
  userDataStale: boolean;
  /** The last confirmation of the account data known (Unix ms). */
  userDataConfirmedSince: number | undefined;
  /** This device had no marks for the account: offer a confirmation. */
  newDevice: boolean;
  /** After a login with a backup code: how many are left. */
  backupCodesRemaining: number | undefined;
  /** After a recovery: the other sessions were signed out. */
  recovered: boolean;
}

const NO_BANNERS: Banners = {
  recoveryKeyUnconfirmed: false,
  kdfBelowDefault: false,
  userDataCorrupt: false,
  userDataReadOnly: false,
  userDataRollback: false,
  userDataStale: false,
  userDataConfirmedSince: undefined,
  newDevice: false,
  backupCodesRemaining: undefined,
  recovered: false,
};

/**
 * The open second-factor step of a login. It holds wrap_key in the core,
 * so it stays out of the reactive state; its timer ends it.
 */
let secondFactorStep: SecondFactorLogin | undefined;
let secondFactorTimer: ReturnType<typeof setTimeout> | undefined;

/** Nothing of the unlocked session stays: view state, clipboard. */
function endSession(): void {
  useBrowseStore().reset();
  clearPendingClipboard();
  const session = useSessionStore();
  session.contacts = [];
  session.ownFingerprint = undefined;
  session.contactsWritable = false;
  useConfirmationStore().reset();
}

let autoLock: AutoLock | undefined;

/**
 * Raised whenever this tab locks, logs out or starts over. An unlock, login
 * or second factor answered later belongs to an operation that no longer
 * counts: its result is dropped.
 */
let generation = 0;

/** Throws `locked` if the tab locked or logged out since `started`. */
function stillCurrent(started: number): void {
  if (started !== generation) throw new AccountError("locked");
}

interface SessionState {
  phase: Phase;
  fatal: FatalKind | undefined;
  email: string | undefined;
  banners: Banners;
  /** Weaker KDF than last seen: `old` and `new` as "ops / MiB". */
  kdfWarning: { old: string; new: string } | undefined;
  kdf: { ops: number; mem: number } | undefined;
  settings: Settings;
  notice: Notice;
  /** Path to return to after unlocking. */
  returnTo: string | undefined;
  /** The registration flow still shows the recovery key. */
  confirmingRecoveryKey: boolean;
  /** Loading a chunk failed after a deploy. */
  preloadFailed: boolean;
  /** Verified contacts for display; no keys. */
  contacts: ContactView[];
  /** From the locally derived public key only. */
  ownFingerprint: string | undefined;
  contactsWritable: boolean;
  /** The login waits for a second factor. */
  secondFactor: { methods: SecondFactorMethod[] } | undefined;
  /** `features.favicon` of the server. */
  favicon: boolean;
  /** `features.freshness` of the server: attestations. */
  freshness: boolean;
  /** `features.confirmation`: confirmations by another device. */
  confirmation: boolean;
  /** Strict mode applies on this device. */
  strictMode: boolean;
}

export const useSessionStore = defineStore("session", {
  state: (): SessionState => ({
    phase: "starting",
    fatal: undefined,
    email: undefined,
    banners: { ...NO_BANNERS },
    kdfWarning: undefined,
    kdf: undefined,
    settings: { ...SETTING_DEFAULTS },
    notice: undefined,
    returnTo: undefined,
    confirmingRecoveryKey: false,
    preloadFailed: false,
    contacts: [],
    ownFingerprint: undefined,
    contactsWritable: false,
    secondFactor: undefined,
    favicon: false,
    freshness: false,
    confirmation: false,
    strictMode: false,
  }),
  actions: {
    /** Startup: server config, then refresh with the cookie. */
    async start(): Promise<void> {
      const { api } = useServices();
      generation += 1;
      this.phase = "starting";
      this.fatal = undefined;
      try {
        const config = await api.config();
        if (config.api_version !== 1) {
          this.fail("version");
          return;
        }
        this.favicon = config.features.favicon;
        this.freshness = config.features.freshness === true;
        this.confirmation = config.features.confirmation === true;
        await api.refresh();
        const me = await api.me();
        this.email = me.email;
        this.phase = "locked";
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          this.phase = "loggedOut";
        } else if (error instanceof ApiError && error.status === 403) {
          this.fail("forbidden");
        } else if (
          error instanceof NetworkError ||
          (error instanceof ApiError && error.status >= 500)
        ) {
          this.fail("unreachable");
        } else {
          this.phase = "loggedOut";
        }
      }
    },

    fail(kind: FatalKind): void {
      this.fatal = kind;
      this.phase = "fatal";
    },

    /** Unlocks, or opens the second-factor step. */
    async login(
      email: string,
      password: string,
    ): Promise<"unlocked" | "second_factor"> {
      const { account } = useServices();
      this.endSecondFactor();
      const started = generation;
      const result = await this.guardIntegrity(() =>
        account.login(email, password),
      );
      stillCurrent(started);
      if (result.kind === "second_factor") {
        this.beginSecondFactor(result.step);
        return "second_factor";
      }
      this.finishLogin(result.report);
      return "unlocked";
    },

    finishLogin(report: UnlockReport): void {
      const { account, tabs } = useServices();
      this.applyUnlocked(report);
      this.banners.backupCodesRemaining = report.backupCodesRemaining;
      tabs.send({ type: "session", userId: account.userId ?? "" });
    },

    /** After a recovery: unlocked, other sessions signed out. */
    finishRecovery(report: UnlockReport): void {
      this.finishLogin(report);
      this.banners.recovered = true;
    },

    beginSecondFactor(step: SecondFactorLogin): void {
      secondFactorStep = step;
      this.secondFactor = { methods: [...step.methods] };
      this.notice = undefined;
      secondFactorTimer = setTimeout(
        () => {
          this.endSecondFactor();
          this.notice = "secondFactorExpired";
        },
        Math.max(0, step.expiresAt - Date.now()),
      );
    },

    /** Back to the first step; the core wipes wrap_key. */
    endSecondFactor(): void {
      clearTimeout(secondFactorTimer);
      secondFactorTimer = undefined;
      secondFactorStep?.discard();
      secondFactorStep = undefined;
      this.secondFactor = undefined;
    },

    async completeSecondFactor(
      run: (step: SecondFactorLogin) => Promise<UnlockReport>,
    ): Promise<void> {
      const step = secondFactorStep;
      if (!step) throw new AccountError("challenge_expired");
      const started = generation;
      try {
        const report = await this.guardIntegrity(() => run(step));
        stillCurrent(started);
        this.endSecondFactor();
        this.finishLogin(report);
      } catch (error) {
        // challenge_invalid, account_disabled, expiry: back to step one.
        if (step.isDiscarded) this.endSecondFactor();
        throw error;
      }
    },

    secondFactorTotp(code: string): Promise<void> {
      return this.completeSecondFactor((step) => step.totp(code));
    },

    secondFactorBackupCode(code: string): Promise<void> {
      return this.completeSecondFactor((step) => step.backupCode(code));
    },

    /** Options from the server, the browser's ceremony, then the check. */
    secondFactorPasskey(): Promise<void> {
      return this.completeSecondFactor(async (step) => {
        const options = await step.passkeyOptions();
        return step.passkey(await getPasskey(options));
      });
    },

    async unlock(password: string): Promise<void> {
      const { account } = useServices();
      const started = generation;
      try {
        const report = await this.guardIntegrity(() =>
          account.unlock(password),
        );
        stillCurrent(started);
        this.applyUnlocked(report);
      } catch (error) {
        if (error instanceof ApiError && error.code === "session_invalid") {
          this.expire();
          return;
        }
        throw error;
      }
    },

    /** Integrity errors end the session. */
    async guardIntegrity<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await run();
      } catch (error) {
        if (error instanceof AccountError && error.code === "integrity") {
          await this.logout(false).catch(() => undefined);
          this.fail("integrity");
        }
        throw error;
      }
    },

    /**
     * After login, unlock or a finished registration or recovery; never
     * "unlocked" while the core is not.
     */
    applyUnlocked(report?: UnlockReport): void {
      const { account } = useServices();
      if (!account.isUnlocked) throw new AccountError("locked");
      this.email = account.email;
      this.phase = "unlocked";
      this.notice = undefined;
      this.refreshFromAccount();
      if (report) {
        this.banners = {
          ...NO_BANNERS,
          recoveryKeyUnconfirmed: report.recoveryKeyUnconfirmed,
          kdfBelowDefault: report.kdfBelowDefault,
          userDataCorrupt: report.userDataCorrupt,
          userDataReadOnly: report.userDataReadOnly,
          userDataRollback: report.userDataRollback,
          userDataStale: report.userDataStale,
          newDevice: report.newDevice,
        };
        const seen = report.kdfWeakerThanSeen;
        this.kdfWarning = seen && this.kdf ? this.describeWeaker() : undefined;
      }
      autoLock ??= new AutoLock(() => {
        this.lock(false);
      });
      autoLock.start(this.settings);
      this.startSync();
    },

    /** A long-running task counts as activity for the auto-lock. */
    markActivity(): void {
      autoLock?.markActivity();
    },

    /** Sync of all vaults while unlocked. */
    startSync(): void {
      const { account } = useServices();
      const engine = account.startSync({
        socket: browserSocket,
        onSessionEnded: () => {
          this.expire();
        },
        onUserDataChanged: () => {
          this.refreshFromAccount();
        },
        onConfirmationsChanged: () => {
          void useConfirmationStore().changed();
        },
      });
      useVaultsStore().attach(engine);
      void useConfirmationStore().refreshIncoming();
    },

    /** The last seen parameters stay stored until the user acknowledges. */
    describeWeaker(): { old: string; new: string } | undefined {
      const userId = useServices().account.userId;
      const seen = userId ? kdfMemory.get(userId) : undefined;
      const format = (cost: { ops: number; mem: number }) =>
        `${String(cost.ops)} / ${String(cost.mem / 1048576)} MiB`;
      return this.kdf && seen
        ? { old: format(seen), new: format(this.kdf) }
        : undefined;
    },

    /** Copies what the UI needs from the account (no keys). */
    refreshFromAccount(): void {
      const { account } = useServices();
      // A late answer after a lock brings nothing back into the view.
      if (!account.isUnlocked) return;
      const kdf = account.kdf;
      this.kdf = kdf ? { ops: kdf.ops, mem: kdf.mem } : undefined;
      this.settings = { ...account.settings };
      this.banners.recoveryKeyUnconfirmed = !account.recoveryKeyConfirmed;
      const state = account.userDataState;
      this.banners.userDataCorrupt = state?.status === "corrupt";
      this.banners.userDataReadOnly = state?.status === "ok" && state.readOnly;
      this.banners.userDataRollback = account.userDataRollback;
      this.banners.userDataStale = account.userDataStale;
      this.banners.userDataConfirmedSince = account.userDataConfirmedSince;
      this.strictMode = account.strictMode;
      if (!account.isNewDevice) this.banners.newDevice = false;
      this.contacts = account.contacts;
      this.ownFingerprint = account.ownFingerprint;
      this.contactsWritable = account.contactsWritable;
      if (this.settings.language && this.settings.language !== currentLocale())
        setLocale(this.settings.language);
      autoLock?.update(this.settings);
    },

    /**
     * "Matches" in the fingerprint dialog. The candidate goes to
     * the core unwrapped: it knows only its own objects.
     */
    async verifyContact(candidate: Candidate): Promise<void> {
      const started = generation;
      await useServices().account.verifyContact(toRaw(candidate));
      stillCurrent(started);
      this.refreshFromAccount();
    },

    async removeContact(userId: string): Promise<void> {
      const started = generation;
      await useServices().account.removeContact(userId);
      stillCurrent(started);
      this.refreshFromAccount();
    },

    async acknowledgeUserDataRollback(): Promise<void> {
      const started = generation;
      await useServices().account.acknowledgeUserDataRollback();
      stillCurrent(started);
      this.refreshFromAccount();
    },

    /**
     * "Understood" at the freshness banner: the delivered account data and
     * every unconfirmed vault count as current now.
     */
    async acknowledgeFreshness(): Promise<void> {
      const started = generation;
      await useServices().account.acknowledgeUserDataFreshness();
      stillCurrent(started);
      await useVaultsStore().engine().acknowledgeFreshness();
      stillCurrent(started);
      this.refreshFromAccount();
    },

    acknowledgeKdf(): void {
      useServices().account.acknowledgeKdf();
      this.kdfWarning = undefined;
    },

    /** Locks this tab; a manual lock also locks the other tabs. */
    lock(broadcast = true): void {
      const { account, tabs } = useServices();
      generation += 1;
      autoLock?.stop();
      this.endSecondFactor();
      account.lock();
      useVaultsStore().detach();
      endSession();
      this.confirmingRecoveryKey = false;
      if (this.phase === "unlocked") this.phase = "locked";
      if (broadcast) tabs.send({ type: "lock" });
    },

    /** Wipes locally first, then revokes the session. */
    async logout(broadcast = true): Promise<void> {
      const { account, tabs } = useServices();
      generation += 1;
      autoLock?.stop();
      this.endSecondFactor();
      useVaultsStore().detach();
      endSession();
      this.phase = "loggedOut";
      this.email = undefined;
      this.banners = { ...NO_BANNERS };
      this.kdfWarning = undefined;
      this.confirmingRecoveryKey = false;
      if (broadcast) tabs.send({ type: "logout" });
      try {
        await account.logout();
        this.notice = undefined;
      } catch (error) {
        this.notice = "logoutFailed";
        throw error;
      }
    },

    /** Another tab logged out; it already told the server. */
    loggedOutElsewhere(): void {
      const { account, api } = useServices();
      generation += 1;
      autoLock?.stop();
      this.endSecondFactor();
      account.lock();
      useVaultsStore().detach();
      endSession();
      api.setAccessToken(undefined);
      this.phase = "loggedOut";
      this.email = undefined;
      this.confirmingRecoveryKey = false;
    },

    /** The session ended elsewhere (revoked, expired). */
    expire(): void {
      const { account, api } = useServices();
      generation += 1;
      autoLock?.stop();
      this.endSecondFactor();
      account.lock();
      useVaultsStore().detach();
      endSession();
      api.setAccessToken(undefined);
      this.phase = "loggedOut";
      this.notice = "expired";
    },

    /** After `DELETE /v1/me`: the other tabs log out too. */
    async deleteAccount(password: string): Promise<void> {
      const { account, tabs } = useServices();
      const userId = account.userId;
      await account.deleteAccount(password);
      if (userId) viewState.forget(userId);
      autoLock?.stop();
      useVaultsStore().detach();
      endSession();
      tabs.send({ type: "logout" });
      this.phase = "loggedOut";
      this.email = undefined;
      this.banners = { ...NO_BANNERS };
      this.kdfWarning = undefined;
      this.notice = "accountDeleted";
    },

    async updateSettings(change: Partial<Settings>): Promise<void> {
      const started = generation;
      await useServices().account.updateSettings(change);
      stillCurrent(started);
      this.refreshFromAccount();
    },

    async resetUserData(language: Language): Promise<void> {
      const started = generation;
      await useServices().account.resetUserData(language);
      stillCurrent(started);
      this.refreshFromAccount();
    },
  },
});

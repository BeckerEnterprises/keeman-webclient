/**
 * Confirmation by another device: the state of this tab's own request and
 * the requests of other devices to confirm. Plain data only; the nonce and
 * the answer stay in the core.
 */
import type { ConfirmationRequest } from "@keeman/core";
import { defineStore } from "pinia";
import { toUiError, type UiError } from "../errors";
import { useServices } from "../services";
import { useSessionStore } from "./session";
import { useVaultsStore } from "./vaults";

/** While a request is open, the answer is looked for this often too. */
const POLL_MS = 15_000;

export type OwnRequest =
  | { status: "waiting"; expiresAt: number }
  | { status: "confirmed"; vaults: number; confirmed: number; missing: number }
  | { status: "failed"; error: UiError };

let poll: ReturnType<typeof setInterval> | undefined;

function stopPolling(): void {
  if (poll !== undefined) clearInterval(poll);
  poll = undefined;
}

interface ConfirmationState {
  own: OwnRequest | undefined;
  /** Open requests of other sessions, oldest first; names are server claims. */
  incoming: ConfirmationRequest[];
  /** Hidden on this tab ("later"). */
  dismissed: string[];
  /** The session that asked when the user said "that wasn't me". */
  declinedSession: string | undefined;
}

export const useConfirmationStore = defineStore("confirmation", {
  state: (): ConfirmationState => ({
    own: undefined,
    incoming: [],
    dismissed: [],
    declinedSession: undefined,
  }),

  getters: {
    /** The request the dialog shows next. */
    shown(state): ConfirmationRequest | undefined {
      return state.incoming.find((r) => !state.dismissed.includes(r.requestId));
    },
  },

  actions: {
    /** Asks the other devices of the account to confirm this one. */
    async request(): Promise<void> {
      stopPolling();
      try {
        const { expiresAt } = await useServices().account.requestConfirmation();
        this.own = { status: "waiting", expiresAt };
        poll = setInterval(() => {
          void this.check();
        }, POLL_MS);
      } catch (caught) {
        this.own = { status: "failed", error: toUiError(caught) };
      }
    },

    /** Looks for the answer to the own request. */
    async check(): Promise<void> {
      if (this.own?.status !== "waiting") return;
      try {
        const result = await useServices().account.checkConfirmation();
        if (result.status === "waiting") return;
        stopPolling();
        if (result.status === "confirmed") {
          this.own = result;
          const session = useSessionStore();
          session.banners.newDevice = false;
          session.refreshFromAccount();
        } else {
          // Replaced by another tab of this session, or gone with a lock.
          this.own = undefined;
        }
      } catch (caught) {
        stopPolling();
        this.own = { status: "failed", error: toUiError(caught) };
      }
    },

    async cancel(): Promise<void> {
      stopPolling();
      this.own = undefined;
      await useServices().account.cancelConfirmation();
    },

    /** Requests of other sessions; nothing while locked. */
    async refreshIncoming(): Promise<void> {
      const { account } = useServices();
      if (!account.isUnlocked) return;
      try {
        const incoming = await account.confirmationRequests();
        // A lock while waiting brings nothing back.
        if (useServices().account.isUnlocked) this.incoming = incoming;
      } catch {
        // The next event or reconnect tries again.
      }
    },

    /**
     * A request was made, answered or deleted somewhere in the account:
     * the own answer may be there, and a tab of the same session may have
     * taken over marks that this tab should read again.
     */
    async changed(): Promise<void> {
      await this.refreshIncoming();
      if (this.own?.status === "waiting") {
        await this.check();
        return;
      }
      const { account } = useServices();
      if (!account.isUnlocked) return;
      try {
        await account.reloadUserData();
        await useVaultsStore().engine().refresh();
        useSessionStore().refreshFromAccount();
      } catch {
        // Read again at the next sync.
      }
    },

    /** "Confirm" in the dialog. */
    async confirm(requestId: string): Promise<void> {
      await useServices().account.confirmRequest(requestId);
      this.incoming = this.incoming.filter((r) => r.requestId !== requestId);
    },

    /** "That wasn't me": the request goes; the sessions page marks it. */
    async decline(request: ConfirmationRequest): Promise<void> {
      await useServices().account.declineRequest(request.requestId);
      this.incoming = this.incoming.filter(
        (r) => r.requestId !== request.requestId,
      );
      this.declinedSession = request.sessionId;
    },

    later(requestId: string): void {
      this.dismissed.push(requestId);
    },

    reset(): void {
      stopPolling();
      this.$reset();
    },
  },
});

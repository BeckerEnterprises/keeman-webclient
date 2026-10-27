/**
 * Invitations and pending keys: opened with the
 * sender's key, accepted only from verified contacts and, where the vault
 * has a roles chain, only when the chain commits to the boxed key;
 * re-wrapped with the own user key. The vault key enters the KeyStore
 * after the server agreed.
 */
import { ApiError } from "../api/errors";
import type { components } from "../api/openapi.gen";
import type { VaultSummary } from "../api/schemas";
import { openVaultKeyBox } from "../crypto/box";
import { wipe } from "../crypto/bytes";
import { CryptoError } from "../crypto/errors";
import { acceptKeyGrant, type KeyGrantAcceptance } from "../crypto/flows/vault";
import { systemRandomness } from "../crypto/random";
import type { RolePoint } from "../crypto/roles";
import { SyncError, type SyncErrorCode } from "../sync/errors";
import { keyOf, statusNow, type Candidate } from "./candidate";
import type { SharingContext } from "./context";

type KeyGrant = components["schemas"]["KeyGrant"];

/**
 * The vault name of an invitation for display before the user decided;
 * the vault key is wiped at once.
 */
export function grantName(
  ctx: SharingContext,
  vaultId: string,
  grant: KeyGrant,
  sender: Candidate,
): string | undefined {
  try {
    const opened = ctx.keys.usePrivateKey((privateKey) =>
      openVaultKeyBox(grant.key_box, privateKey, keyOf(sender).publicKey, {
        ownUserId: ctx.userId,
        senderId: grant.sender_id,
        vaultId,
        keyVersion: grant.key_version,
      }),
    );
    wipe(opened.vaultKey);
    return opened.vaultName;
  } catch (error) {
    if (error instanceof CryptoError && error.code === "locked") throw error;
    return undefined;
  }
}

/**
 * Who may send a pending key of a vault without roles chain: the owners
 * this device remembers, or anyone once the user confirmed that the sender
 * really is an owner.
 */
export interface KeySenders {
  owners: readonly string[];
  confirmed: boolean;
}

/** Checks the opened box against the roles chain: the rejection, if any. */
export type RolesCheck = (opened: {
  vaultKey: Uint8Array;
  roles: RolePoint | undefined;
  created: string;
  manifest: number | undefined;
}) => SyncErrorCode | undefined;

/**
 * Accepts the invitation (`invitation`) or the pending key (`key`). With
 * `roles` the chain must commit to the boxed key; without a chain a pending
 * key needs a known owner or the user's confirmation, so a server cannot
 * pass off the box of a removed member as a new key version.
 */
export async function acceptGrant(
  ctx: SharingContext,
  kind: "invitation" | "key",
  summary: VaultSummary,
  sender: Candidate,
  checks: { senders?: KeySenders; roles?: RolesCheck } = {},
): Promise<void> {
  const { senders, roles } = checks;
  const vaultId = summary.vault_id;
  const grant =
    kind === "invitation" ? summary.invitation : summary.pending_key;
  if (!grant) throw new SyncError("not_found");
  if (
    grant.sender_id !== sender.userId ||
    statusNow(sender, ctx.contacts()) !== "verified"
  )
    throw new SyncError("unverified");
  if (
    kind === "key" &&
    !roles &&
    !senders?.confirmed &&
    !senders?.owners.includes(sender.userId)
  )
    throw new SyncError("unknown_owner");
  let accepted: KeyGrantAcceptance;
  try {
    accepted = ctx.keys.useUserKey((userKey) =>
      ctx.keys.usePrivateKey((privateKey) =>
        acceptKeyGrant(systemRandomness, {
          grant,
          vaultId,
          ownUserId: ctx.userId,
          ownPrivateKey: privateKey,
          userKey,
          senderPublicKey: keyOf(sender).publicKey,
          ...(kind === "key"
            ? { currentKeyVersion: summary.member_key_version }
            : {}),
        }),
      ),
    );
  } catch (error) {
    if (error instanceof CryptoError && error.code === "locked") throw error;
    throw new SyncError("key_box_invalid");
  }
  const rejected = roles?.(accepted);
  if (rejected) {
    wipe(accepted.vaultKey);
    throw new SyncError(rejected);
  }
  try {
    await (kind === "invitation"
      ? ctx.api.acceptInvitation(vaultId, accepted.request)
      : ctx.api.acceptVaultKey(vaultId, accepted.request));
  } catch (error) {
    // A repetition after a lost answer finds nothing pending.
    const done =
      error instanceof ApiError &&
      error.status === 404 &&
      (await ctx.api.vaults()).some(
        (v) =>
          v.vault_id === vaultId &&
          v.state === "active" &&
          v.member_key_version >= grant.key_version,
      );
    if (!done) {
      wipe(accepted.vaultKey);
      throw error;
    }
  }
  ctx.keys.setVaultKey(vaultId, grant.key_version, accepted.vaultKey);
}

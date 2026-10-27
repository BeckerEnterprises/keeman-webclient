/**
 * Members of a vault: lookup, invite, list, roles, withdraw and
 * leave. Invitations go only to verified contacts.
 */
import { ApiError } from "../api/errors";
import { buildKeyBox } from "../crypto/flows/vault";
import { systemRandomness } from "../crypto/random";
import type { RolePoint, SignedRoles } from "../crypto/roles";
import { SyncError } from "../sync/errors";
import { keyOf, statusNow, toCandidate, type Candidate } from "./candidate";
import type { SharingContext } from "./context";

export interface MemberView {
  readonly userId: string;
  /** The contact's address if there is one, else the server's. */
  readonly email: string;
  /** From the checked roles chain where the vault has one (`signed`). */
  readonly role: "owner" | "member";
  /** The role comes from the checked roles chain. */
  readonly signed: boolean;
  /** The server names another role than the roles chain. */
  readonly roleMismatch: boolean;
  readonly state: "pending" | "active";
  readonly invitedBy: string | null;
  readonly created: string;
  readonly self: boolean;
  readonly candidate: Candidate;
}

export async function lookup(
  ctx: SharingContext,
  email: string,
): Promise<Candidate> {
  const user = await ctx.api.lookupUser(email);
  return toCandidate(user, ctx.contacts(), ctx.userId);
}

/** Members and pending invitations with their status. */
export async function memberViews(
  ctx: SharingContext,
  vaultId: string,
): Promise<MemberView[]> {
  const contacts = ctx.contacts();
  const members = await ctx.api.members(vaultId);
  return members.map((m) => {
    const candidate = toCandidate(m, contacts, ctx.userId);
    const contact = contacts.find((c) => c.userId === m.user_id);
    return {
      userId: m.user_id,
      email: contact?.email ?? m.email,
      role: m.role,
      signed: false,
      roleMismatch: false,
      state: m.state,
      invitedBy: m.invited_by,
      created: m.created,
      self: candidate.self,
      candidate,
    };
  });
}

export interface InviteTarget {
  vaultId: string;
  keyVersion: number;
  vaultName: string;
  /** The checked head of the roles chain the box vouches for. */
  roles?: RolePoint | undefined;
}

/** A box with the current vault key for a verified contact. */
export async function invite(
  ctx: SharingContext,
  target: InviteTarget,
  candidate: Candidate,
): Promise<void> {
  if (candidate.self) throw new SyncError("self");
  if (statusNow(candidate, ctx.contacts()) !== "verified")
    throw new SyncError("unverified");
  if (!ctx.keys.hasVaultKey(target.vaultId, target.keyVersion))
    throw new SyncError("read_only");
  const keyBox = ctx.keys.usePrivateKey((privateKey) =>
    ctx.keys.useVaultKey(target.vaultId, target.keyVersion, (vaultKey) =>
      buildKeyBox(systemRandomness, {
        senderId: ctx.userId,
        senderPrivateKey: privateKey,
        recipientId: candidate.userId,
        recipientPublicKey: keyOf(candidate).publicKey,
        vaultId: target.vaultId,
        keyVersion: target.keyVersion,
        vaultKey,
        vaultName: target.vaultName,
        created: new Date().toISOString(),
        roles: target.roles,
      }),
    ),
  );
  try {
    await ctx.api.inviteMember(target.vaultId, {
      user_id: candidate.userId,
      key_version: target.keyVersion,
      key_box: keyBox,
    });
  } catch (error) {
    // A repetition after a lost answer finds our own invitation.
    if (error instanceof ApiError && error.code === "already_member") {
      const members = await ctx.api.members(target.vaultId);
      const ours = members.some(
        (m) =>
          m.user_id === candidate.userId &&
          m.state === "pending" &&
          m.invited_by === ctx.userId,
      );
      if (ours) return;
    }
    throw error;
  }
}

/** `404` after a lost answer means the invitation is gone already. */
export async function withdraw(
  ctx: SharingContext,
  vaultId: string,
  userId: string,
): Promise<void> {
  try {
    await ctx.api.withdrawInvitation(vaultId, userId);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
}

/** With a roles chain, `roles` is the signed next statement. */
export async function setRole(
  ctx: SharingContext,
  vaultId: string,
  userId: string,
  role: "owner" | "member",
  roles?: SignedRoles,
): Promise<void> {
  await ctx.api.updateMember(vaultId, userId, role, roles);
}

/** Leaving; `404` after a lost answer means the membership is gone. */
export async function leave(
  ctx: SharingContext,
  vaultId: string,
): Promise<void> {
  try {
    await ctx.api.leaveVault(vaultId);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
}

/** Declining; `404` after a lost answer means the invitation is gone. */
export async function decline(
  ctx: SharingContext,
  vaultId: string,
): Promise<void> {
  try {
    await ctx.api.declineInvitation(vaultId);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) throw error;
  }
}

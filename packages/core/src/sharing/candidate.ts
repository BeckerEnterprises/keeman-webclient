/**
 * An account the user is about to trust or share with: its
 * fingerprint for display and its status. The public key stays in the
 * core, so the app cannot slip in another key than the one loaded here.
 */
import type { PublicUser } from "../api/schemas";
import { fromBase64Url } from "../crypto/bytes";
import { fingerprintHex, formatFingerprint } from "../crypto/fingerprint";
import type { Contact } from "../model/user-data";
import { SyncError } from "../sync/errors";
import { contactStatus, type ContactStatus } from "./contacts";

export interface Candidate {
  readonly userId: string;
  /** As the server names it; unverified until the user confirms. */
  readonly email: string;
  /** Display form: 10 groups of 4. */
  readonly fingerprint: string;
  /** Against the contacts at the time the candidate was made. */
  readonly status: ContactStatus;
  /** The own account (the client never invites itself). */
  readonly self: boolean;
}

interface Key {
  publicKey: Uint8Array;
  /** Full fingerprint, 64 uppercase hex characters. */
  fingerprint: string;
}

const keys = new WeakMap<Candidate, Key>();

export function toCandidate(
  user: PublicUser,
  contacts: readonly Contact[],
  ownUserId: string,
): Candidate {
  const publicKey = fromBase64Url(user.public_key, 32);
  const fingerprint = fingerprintHex(publicKey);
  const candidate: Candidate = Object.freeze({
    userId: user.user_id,
    email: user.email,
    fingerprint: formatFingerprint(fingerprint),
    status: contactStatus(contacts, user.user_id, fingerprint),
    self: user.user_id === ownUserId,
  });
  keys.set(candidate, { publicKey, fingerprint });
  return candidate;
}

/** The key the core loaded for this candidate; anything else is refused. */
export function keyOf(candidate: Candidate): Key {
  const key = keys.get(candidate);
  if (!key) throw new SyncError("unverified");
  return key;
}

/** The status against the contacts now, e.g. after a confirmation. */
export function statusNow(
  candidate: Candidate,
  contacts: readonly Contact[],
): ContactStatus {
  return contactStatus(
    contacts,
    candidate.userId,
    keyOf(candidate).fingerprint,
  );
}

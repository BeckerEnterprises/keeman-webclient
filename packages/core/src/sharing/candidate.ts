/**
 * An account the user is about to trust or share with: its
 * fingerprint for display and its status. The public keys stay in the
 * core, so the app cannot slip in other keys than the ones loaded here.
 */
import type { PublicUser } from "../api/schemas";
import { fromBase64Url } from "../crypto/bytes";
import {
  fingerprint2Hex,
  fingerprintHex,
  formatFingerprint,
} from "../crypto/fingerprint";
import type { Contact } from "../model/user-data";
import { SyncError } from "../sync/errors";
import {
  contactStatus,
  type ContactStatus,
  type Fingerprints,
} from "./contacts";

export interface Candidate {
  readonly userId: string;
  /** As the server names it; unverified until the user confirms. */
  readonly email: string;
  /**
   * Display form (10 groups of 4) of fingerprint version 2, or of version 1
   * while the account has no signing key.
   */
  readonly fingerprint: string;
  /** Against the contacts at the time the candidate was made. */
  readonly status: ContactStatus;
  /** The own account (the client never invites itself). */
  readonly self: boolean;
  /**
   * Version 2 exists (or the server knows no signing keys at all), so the
   * account can be verified now.
   */
  readonly verifiable: boolean;
}

interface Key {
  publicKey: Uint8Array;
  /** Missing while the account has no signing key. */
  signingKey: Uint8Array | undefined;
  fingerprints: Fingerprints;
}

const keys = new WeakMap<Candidate, Key>();

export function toCandidate(
  user: PublicUser,
  contacts: readonly Contact[],
  ownUserId: string,
): Candidate {
  const publicKey = fromBase64Url(user.public_key, 32);
  const signingKey =
    typeof user.signing_public_key === "string"
      ? fromBase64Url(user.signing_public_key, 32)
      : undefined;
  const fingerprints: Fingerprints = {
    v1: fingerprintHex(publicKey),
    v2: signingKey ? fingerprint2Hex(publicKey, signingKey) : undefined,
    legacy: user.signing_public_key === undefined,
  };
  const candidate: Candidate = Object.freeze({
    userId: user.user_id,
    email: user.email,
    fingerprint: formatFingerprint(fingerprints.v2 ?? fingerprints.v1),
    status: contactStatus(contacts, user.user_id, fingerprints),
    self: user.user_id === ownUserId,
    verifiable: signingKey !== undefined || fingerprints.legacy === true,
  });
  keys.set(candidate, { publicKey, signingKey, fingerprints });
  return candidate;
}

/** The keys the core loaded for this candidate; anything else is refused. */
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
    keyOf(candidate).fingerprints,
  );
}

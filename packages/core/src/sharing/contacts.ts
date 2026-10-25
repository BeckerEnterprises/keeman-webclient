/**
 * The fingerprint rule: the status of an account against the own
 * contacts, always from a fingerprint computed locally from its key.
 */
import { formatFingerprint } from "../crypto/fingerprint";
import type { Contact } from "../model/user-data";

/** `changed` and `conflict` get a red warning in the dialog. */
export type ContactStatus = "verified" | "unverified" | "changed" | "conflict";

/** `fingerprint` is the full fingerprint, 64 uppercase hex characters. */
export function contactStatus(
  contacts: readonly Contact[],
  userId: string,
  fingerprint: string,
): ContactStatus {
  const contact = contacts.find((c) => c.userId === userId);
  if (!contact) return "unverified";
  if (contact.conflict === true) return "conflict";
  return contact.fingerprint === fingerprint ? "verified" : "changed";
}

/** A contact for display. */
export interface ContactView {
  readonly userId: string;
  /** The address the server named at the verification. */
  readonly email: string;
  /** Display form: 10 groups of 4. */
  readonly fingerprint: string;
  readonly verifiedAt: string;
  readonly conflict: boolean;
}

export function contactViews(contacts: readonly Contact[]): ContactView[] {
  return contacts.map((c) => ({
    userId: c.userId,
    email: c.email,
    fingerprint: formatFingerprint(c.fingerprint),
    verifiedAt: c.verifiedAt,
    conflict: c.conflict === true,
  }));
}

/**
 * The fingerprint rule: the status of an account against the own
 * contacts, always from fingerprints computed locally from its keys.
 */
import { formatFingerprint } from "../crypto/fingerprint";
import type { Contact } from "../model/user-data";

/**
 * `changed` and `conflict` get a red warning in the dialog; `outdated`
 * (checked before fingerprint version 2) asks for one new comparison.
 * Only `verified` counts as verified.
 */
export type ContactStatus =
  "verified" | "outdated" | "unverified" | "changed" | "conflict";

/** Full fingerprints (64 uppercase hex characters) computed locally. */
export interface Fingerprints {
  v1: string;
  /** Missing while the account has no signing key. */
  v2: string | undefined;
  /**
   * The server knows no signing keys at all (it does not name the field):
   * a contact without version 2 counts with version 1, as before.
   */
  legacy?: boolean;
}

export function contactStatus(
  contacts: readonly Contact[],
  userId: string,
  fingerprints: Fingerprints,
): ContactStatus {
  const contact = contacts.find((c) => c.userId === userId);
  if (!contact) return "unverified";
  if (contact.conflict === true) return "conflict";
  if (contact.fingerprint2 !== undefined)
    return fingerprints.v2 !== undefined &&
      contact.fingerprint2 === fingerprints.v2
      ? "verified"
      : "changed";
  if (contact.fingerprint !== fingerprints.v1) return "changed";
  return fingerprints.legacy === true ? "verified" : "outdated";
}

/** A contact for display. */
export interface ContactView {
  readonly userId: string;
  /** The address the server named at the verification. */
  readonly email: string;
  /** Display form (10 groups of 4) of the newest stored fingerprint. */
  readonly fingerprint: string;
  readonly verifiedAt: string;
  readonly conflict: boolean;
  /** Checked before fingerprint version 2; compare once more. */
  readonly outdated: boolean;
}

const FINGERPRINT = /^[0-9A-F]{64}$/;

export function contactViews(contacts: readonly Contact[]): ContactView[] {
  return contacts.map((c) => {
    const v2 =
      typeof c.fingerprint2 === "string" && FINGERPRINT.test(c.fingerprint2)
        ? c.fingerprint2
        : undefined;
    return {
      userId: c.userId,
      email: c.email,
      fingerprint: formatFingerprint(v2 ?? c.fingerprint),
      verifiedAt: c.verifiedAt,
      conflict: c.conflict === true,
      outdated: c.fingerprint2 === undefined,
    };
  });
}

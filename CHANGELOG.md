# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Upgrading: needs a server that reports `features.manifest`; with an older server databases stay "unverified". Tabs opened before the update stop syncing a database once it has a manifest and cannot save there; reloading the page fixes this.

Freshness attestations and pairing need a server that reports `features.freshness`; with an older server nothing is uploaded, pairing is not offered, and a new device shows its databases as unconfirmed until "Understood". Devices that synced before this version count their state as confirmed once, at the first sync after the update.

Signed roles need a server that reports `features.roles`; with an older server the earlier rules stay. Accounts registered before add their signing key after their next unlock (after a sign-in with a second factor, at the unlock that follows). Contacts verified before are marked "outdated" and count as not verified until their fingerprint is compared once more; until then new keys from them wait for that comparison.

### Security

- Freshness on new and long-unused devices: each device signs, with the account's signing key, which state of a database and of the account data it confirmed and when. A device whose own confirmation is older than the period (7 days by default, 1–90 in the settings) needs such an attestation of its own account; otherwise the database stays read-only with the warning "No device of your account has confirmed the state since …", takes no new key and allows no invitation, promotion or key renewal until the device is paired or the user confirms. Own attestations also act as floors: an older key version, manifest root or owner list than one ever attested is a rollback. Only the own account's attestations count, checked with the locally derived key; anything else is ignored.
- A device signs only states without warnings, and never an owner list it has not taken over. "Understood" at a rollback, manifest or owner list warning takes the delivered state as confirmed and replaces an own attestation that contradicts it.
- An invitation confirms the new member's state only when its sender is an owner of the statement the box names; a pending key never confirms a state.
- Owner-signed roles: every database keeps a chain of statements signed by its owners, naming the owners with their keys and committing to the vault key of each key version. A new key after a rotation, and the key of an invitation, is accepted only when the chain, checked from this account's last checked statement, commits to exactly that key. A server can no longer pass off the key of a removed member, even when it names that member as owner.
- The account's Ed25519 signing key follows from its user key; unlocking checks the server's copy. The fingerprint of an account now covers both public keys (version 2).
- Role changes and rotations are signed; promoting needs a contact verified with the new fingerprint. Owners step down, signed, before leaving a database or deleting the account, and drop owners who are no longer members from the chain.
- An older, contradictory or hidden owner list makes the database refuse new keys and role changes, with the warning "The server delivered an older owner list" or "The owner list is contradictory"; "Understood" takes the delivered list after a confirmation.

### Added

- Pair devices: a device shows a 24-character code (also as a QR code), and another device of the account takes over its high-water marks and confirmations with it, typed or from an image. Afterwards it recognises every older state the server delivers. New devices are offered pairing after the first unlock.
- The confirmation period in the settings.
- Vault manifest: every database carries an encrypted list of all its objects with a hash of each. After every sync the web client checks what the server delivered against it, also on a new device. If objects are missing, differ or are not listed, the database becomes read-only with the warning "The server is withholding data", the counts and a list on the database page.
- "Understood" at that warning asks first, then syncs in full, accepts the delivered state and writes the manifest anew.
- New databases get their manifest at once, existing ones after their first full sync; a database without one is marked "unverified".
- A key rotation checks the state it collected against the manifest, refuses an older one than this device has seen, and renews the manifest with the new key.
- The member list shows roles from the signed owner list ("signed") and warns when the server names others. A database with a signed list this account has no checked statement for yet asks once to take it over, naming its owners; an owner of an older database starts its list once the other owners are verified.

### Changed

- The main view no longer cancels a navigation started while the first database was still loading.
- Every save also writes the manifest. Saves of two devices at the same time therefore always meet; the second is planned again without a notice, and only real conflicts count towards the three attempts.

## [0.1.1] - 2026-10-26

Security release after a code review and a whitebox security audit of 0.1.0. KeeMan is still in early development: do not use it with real passwords yet. Use it with KeeMan Server 0.1.1.

### Security

- A server can no longer roll back the vault key version unnoticed: the device remembers the highest key version of each database, makes the database read-only with a warning when the server delivers a lower one, and never encrypts with an older key.
- Placeholders have work limits: one value resolves at most 1000 references and produces at most 1,048,576 characters. Beyond that it stays unresolved with a note ("Too many references"), so a prepared entry cannot freeze the tab.
- Auto-lock in Firefox and Safari: when the browser refuses to clear the clipboard, the next click or key in the tab clears it, also on the lock screen.
- A new vault key after a rotation is taken without asking only from an owner this device has seen while it held the current key; otherwise the user confirms that the sender really is an owner. A server can no longer pass off the key box of a removed member, who is still a verified contact, as a new key version.
- Reading placeholders and URL templates takes linear time: a value with many `{` before one `}` no longer freezes list views.
- At login the key derivation parameters actually used (from `prelogin`) are compared with the ones seen before, also after a second factor; a failing unlock after weaker parameters mentions manipulated parameters.
- Locking (by hand, by the timer or from another tab), logging out and switching accounts end an unlock, login, second factor, recovery or registration still waiting for an answer: it takes over no keys and the view stays locked. Before, a late answer could unlock the tab again, and a lock during a second factor or recovery ended in a false integrity error.
- The sync engine uses the keys of the current unlock only; a task of a stopped engine never adds a key to a later unlock.
- The same holds for writes of the account data (settings, contacts, recovery key confirmation, database order, reset), password and KDF changes, account deletion, attachment uploads and reads, and preparing a recovery: one that a lock overtook puts no decrypted data back, also not into another account signed in meanwhile. Without unlocked keys the account data reads as defaults.
- An attachment is read only up to the server's upload limit, whatever size its entry states, and a download stops beyond the largest blob that size allows; a KDBX export keeps at most 1 GiB of attachments and names the rest in its report. A member can no longer exhaust another member's memory with small attachments that unpack big. The export checks the total with the size each read uses, before downloading, and again with the length actually read.

### Fixed

- A corrupt update no longer hides an entry or group: the last valid version stays visible, read-only and marked.
- A full storage quota (`507`) is reported at once instead of being offered for a retry, and the message covers all data, not only attachments.
- The build check and the KeePassXC reference tests work in folders with spaces in their path.

## [0.1.0] - 2026-10-25

First public release. KeeMan is in early development: do not use it with real passwords yet, and note that the code has not been reviewed externally.

### Added

- Client core `@keeman/core` without Vue or DOM: all encryption with libsodium (Argon2id, XChaCha20-Poly1305, X25519 boxes, secretstream for files), a key store that wipes keys on lock, sync with conflict merging and rollback detection, and the shared test vectors.
- Web app (Vue 3) with a KeePassXC-like layout: several databases side by side, a group tree of any depth, entry list and details, keyboard shortcuts, German and English.
- Entries with custom and protected fields, history, tags, expiry dates, attachments with preview, live TOTP codes (also from QR codes), URL placeholders and references in KeePass style, and a password and passphrase generator.
- Icons: a built-in set, own uploads and favicons, all re-encoded as PNG.
- KDBX import and export (KeePass 2, KeePassXC), including attachments and custom icons.
- Sharing databases with other accounts after a fingerprint check; removing a member renews the vault key.
- Account: two-factor login (TOTP, passkeys, backup codes), recovery key, password change, stronger key derivation, sessions, contacts, settings and account deletion.
- Strict Content Security Policy, no third-party resources, auto-lock and clipboard clearing.
- Container image (`Dockerfile`): the built app served by Caddy on port 8080 as a non-root user, with the same security headers as a manual setup; `KEEMAN_API_HOST` sets the API address in the Content Security Policy and in `config.json`. `scripts/check-image.sh` builds and starts the image and checks its headers.

[0.1.1]: https://github.com/BeckerEnterprises/keeman-webclient/releases/tag/v0.1.1
[0.1.0]: https://github.com/BeckerEnterprises/keeman-webclient/releases/tag/v0.1.0

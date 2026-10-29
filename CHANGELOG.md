# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

Upgrading: needs a server that reports `features.manifest`; with an older server databases stay "unverified". Tabs opened before the update stop syncing a database once it has a manifest and cannot save there; reloading the page fixes this.

Freshness attestations need a server that reports `features.freshness`; with an older server nothing is uploaded, and a new device shows its databases as unconfirmed until "Understood". Confirmations by another device need a server that reports `features.confirmation`; otherwise they are not offered. Strict mode applies with any server. Devices that synced before this version count their state as confirmed once, at the first sync after the update.

The roles chain is loaded page by page; a server from before that delivers it in one piece works too. Opening a key rotation now names the accounts it removes, which a server from before this change refuses.

Signed roles need a server that reports `features.roles`; with an older server the earlier rules stay. Accounts registered before add their signing key after their next unlock (after a sign-in with a second factor, at the unlock that follows). Contacts verified before are marked "outdated" and count as not verified until their fingerprint is compared once more; until then new keys from them wait for that comparison.

### Security

- A lock while the account data was being confirmed no longer lets the decrypted data back into the locked account when it was reloaded or merged after a conflict.
- A KDBX import whose "Import" was still preparing when the tab locked stops instead of running afterwards, possibly into an account unlocked meanwhile in the tab. Adding an icon and uploading an attachment also stay with the unlock they started in.
- A copy that a lock overtook while it was being written is cleared at once instead of staying in the clipboard until its timer ran out.
- A statement this device made becomes its anchor as soon as the server takes it, and every check compares the list's commitments with the database keys this device holds: a server that drops an owner's rotation and puts the statement of the co-owner it should remove in its place is a contradiction, also on the rotating device. A statement that names this account with keys that are not its own makes the list invalid, whoever signed it. Loading a list stops at 10 000 statements or 64 MiB.
- Owners in warnings and in "Take over" are listed one per line with their own status; the server's addresses with whitespace, commas, control or format characters are not shown. The last comparison partner of a state code is named with a status too.
- Resetting damaged account data keeps the device's comparison points; a rollback found while saving shows at once; a rotation checks the owner list again before it starts and always sends a statement where the database has a list.
- Confirming a dangerous action focuses "Cancel" first, the accept dialog of an invitation "Close".

- A roles chain the server names but this device cannot check (it does not load, is empty or ends below the named head) no longer falls back to the older rule that accepted a new key from anyone the member list calls an owner. The database then stays read-only with "The owner list could not be loaded" and "Try again": no key is accepted, nothing is signed, no role is changed, and the member list's owners are not remembered. Checking no longer depends on the server configuration loading. "Understood" and "Take over" apply only to the owner list that was shown.
- Every lower reference point of the owner list (the account's anchor, the device's floor, roles points of attestations and confirmations) must appear in the delivered list as that very statement; a list delivered only from a higher, forked point on is a contradiction. A confirmation by another device no longer raises the device's own floor directly.
- A list in the account's own name is taken over only with the account's own keys.
- After `409` when saving account data, the delivered copy is checked like any loaded one before it is merged; an older copy is shown as a rollback and nothing is written, so removed contacts, lowered anchors, dropped comparison points and old settings such as strict mode cannot come back.
- Marks written before any sync (owners, the roles floor, comparison points) and a rolled-back account data no longer count as marks from before confirmation times; the one-time confirmation for older devices needs a synced state.
- The manifest floor of an attestation, an invitation or a confirmation by another device also holds for the delivered manifest root, checked after every sync and at every load of the database list; a manifest root relabelled with an older key version is a mismatch; no manifest is created while an object rollback is open; "Understood" at a manifest warning covers only the rollbacks it showed.
- A key rotation gives no key to a recipient its review did not show, even a verified contact; it starts a new review instead. Opening a rotation names the accounts it removes, so they cannot hold off their removal by writing.
- Owners in warnings, in "Take over" and in the accept dialog are named by the contact only if it is verified with the keys of the list; otherwise the server's information is shown, marked as not verified.
- A re-invitation into a database the account had before warns when its owner list contradicts what the account knew of it, and is accepted only with "Accept anyway".
- An attestation more than a day ahead of the device's clock counts as none, also as a floor; an attestation after an own write names the hash of the new manifest root.
- A sync engine stays bound to its unlock: after a lock or another account signing in in the same tab it neither reads nor writes that account's data.
- A broken value in the device marks drops only that part instead of the marks of every account; counters from the server must be safe integers; at most 64 comparison points per database are kept on the device. Resetting damaged account data writes above every floor.
- The dialog for another device's request focuses "Later".
- Confirmation by another device: a device whose state is unconfirmed asks the other unlocked devices of the account, with a random nonce that never leaves its memory. Another device shows "Another device wants to take over your state" with the device name the server reports and confirms only after a click; it then signs its high-water marks, confirmation times only for databases it would attest itself, and its comparison points, bound to that nonce. The asking device accepts the answer only with its own derived signing key, its own account and its own nonce, so the server cannot forge, replay or redirect one. "That wasn't me" deletes the request and opens the sessions with the asking session marked. A fork the other device's owner list reveals is kept as a comparison point.
- Strict mode "New devices only after confirmation": attestations of other devices no longer confirm a device whose own confirmation is missing or older than the period; they stay floors. It is switched on at once and off on a device only after that device confirmed the account data itself; account data that is unconfirmed, rolled back or damaged never switches it off and makes attestations not count either. It protects new devices reliably once every existing device has loaded the setting and 7 days have passed.
- An invitation confirms the new member's state only while the account data is confirmed.
- State code: each database shows a short code of its checked owner list (version and 26 characters, also as a QR code that names the database) for members to compare over a second channel. A member's code is checked against the statement of the same version only; above the own head the whole list is loaded again. If a code contradicts the list, or names a newer list the server does not deliver, and the user confirms the input, the account keeps it, in the account data and on the device: the database warns about the owner list and stays read-only until "Understood". A server that hides a rotation from a whole account, or a former owner who forks the list to invite someone into an old state, is found this way from either side.
- Every warning about the owner list now makes the database read-only, and nothing is signed on such a list; leaving and deleting the account wait for "Understood".
- Accepting an invitation opens a dialog with the owners of the list the invitation names and the future state code, with the advice to compare it with a member other than the inviter. Accepting is bound to the list the dialog showed and refused when a member's code contradicts it, the invitation does not fit the signed list, or its sender is not an owner of the list it names.
- Freshness on new and long-unused devices: each device signs, with the account's signing key, which state of a database and of the account data it confirmed and when. A device whose own confirmation is older than the period (7 days by default, 1–90 in the settings) needs such an attestation of its own account; otherwise the database stays read-only with the warning "No device of your account has confirmed the state since …", takes no new key and allows no invitation, promotion or key renewal until the device is paired or the user confirms. Own attestations also act as floors: an older key version, manifest root or owner list than one ever attested is a rollback. Only the own account's attestations count, checked with the locally derived key; anything else is ignored.
- A device signs only states without warnings, and never an owner list it has not taken over. "Understood" at a rollback, manifest or owner list warning takes the delivered state as confirmed and replaces an own attestation that contradicts it.
- An invitation confirms the new member's state only when its sender is an owner of the statement the box names; a pending key never confirms a state.
- Owner-signed roles: every database keeps a chain of statements signed by its owners, naming the owners with their keys and committing to the vault key of each key version. A new key after a rotation, and the key of an invitation, is accepted only when the chain, checked from this account's last checked statement, commits to exactly that key. A server can no longer pass off the key of a removed member, even when it names that member as owner.
- The account's Ed25519 signing key follows from its user key; unlocking checks the server's copy. The fingerprint of an account now covers both public keys (version 2).
- Role changes and rotations are signed; promoting needs a contact verified with the new fingerprint. Owners step down, signed, before leaving a database or deleting the account, and drop owners who are no longer members from the chain.
- An older, contradictory or hidden owner list makes the database refuse new keys and role changes, with the warning "The server delivered an older owner list" or "The owner list is contradictory"; "Understood" takes the delivered list after a confirmation.

### Added

- Have this device confirmed: the account page, the banner of an unconfirmed state and the notice at a database ask the other devices; the page waits with the remaining time and reports how many databases were confirmed. Afterwards the device recognises every older state the server delivers. New devices are offered it after the first unlock.
- The confirmation period and strict mode in the settings; the settings say whether this device is strict.
- Vault manifest: every database carries an encrypted list of all its objects with a hash of each. After every sync the web client checks what the server delivered against it, also on a new device. If objects are missing, differ or are not listed, the database becomes read-only with the warning "The server is withholding data", the counts and a list on the database page.
- "Understood" at that warning asks first, then syncs in full, accepts the delivered state and writes the manifest anew.
- New databases get their manifest at once, existing ones after their first full sync; a database without one is marked "unverified".
- A key rotation checks the state it collected against the manifest, refuses an older one than this device has seen, and renews the manifest with the new key.
- The member list shows roles from the signed owner list ("signed") and warns when the server names others. A database with a signed list this account has no checked statement for yet asks once to take it over, naming its owners; an owner of an older database starts its list once the other owners are verified.

### Changed

- The main view no longer cancels a navigation started while the first database was still loading.
- Every save also writes the manifest. Saves of two devices at the same time therefore always meet; the second is planned again without a notice, and only real conflicts count towards the three attempts.
- Reading a QR code from an image (state code) uses one input for text, file, drop and paste.

### Fixed

- Deleting the account could end with "The session has expired" instead of the confirmation, when the server's end of the session reached the tab before the answer to the deletion.
- Reloading an owner list after a conflict now keeps the points of own attestations and pairings; a list that cannot be loaded is still checked against new points up to its last head.
- On a server that stops delivering owner lists, an owner's device kept its last checked list instead of warning, and "Understood" took over that list instead of an empty one; it also works when the list was never checked.
- Merging the account data after a conflict no longer undoes a removed owner list anchor.
- Keys handed on with an invitation or rotation are dated with the device clock the sync uses.

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

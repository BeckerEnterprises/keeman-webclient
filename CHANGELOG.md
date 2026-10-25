# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Security

- A server can no longer roll back the vault key version unnoticed: the device remembers the highest key version of each database, makes the database read-only with a warning when the server delivers a lower one, and never encrypts with an older key.
- Placeholders have work limits: one value resolves at most 1000 references and produces at most 1,048,576 characters. Beyond that it stays unresolved with a note ("Too many references"), so a prepared entry cannot freeze the tab.
- Auto-lock in Firefox and Safari: when the browser refuses to clear the clipboard, the next click or key in the tab clears it, also on the lock screen.
- A new vault key after a rotation is taken without asking only from an owner this device has seen while it held the current key; otherwise the user confirms that the sender really is an owner. A server can no longer pass off the key box of a removed member, who is still a verified contact, as a new key version.
- Reading placeholders and URL templates takes linear time: a value with many `{` before one `}` no longer freezes list views.
- At login the key derivation parameters actually used (from `prelogin`) are compared with the ones seen before, also after a second factor; a failing unlock after weaker parameters mentions manipulated parameters.

### Fixed

- A corrupt update no longer hides an entry or group: the last valid version stays visible, read-only and marked.
- A full storage quota (`507`) is reported at once instead of being offered for a retry, and the message covers all data, not only attachments.

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

[0.1.0]: https://github.com/BeckerEnterprises/keeman-webclient/releases/tag/v0.1.0

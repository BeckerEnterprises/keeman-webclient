# KDBX test files

Fantasy data only, never real passwords. The password of every file is
`test`.

| File                     | Made with                                       | Format                                                   |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------- |
| `keepass-example.kdbx`   | KeePass 2 for Windows (new database, defaults)  | KDBX 4.0, ChaCha20, Argon2id 64 MiB, 2 iterations, P = 2 |
| `keepassxc-example.kdbx` | KeePassXC 2.7                                   | KDBX 4.1, AES-256, Argon2d 64 MiB, 10 iterations, P = 4  |
| `keeman-sample.kdbx`     | `keepassxc-cli import` from `keeman-sample.xml` | KDBX 4.1, AES-256, AES-KDF                               |

## Contents

- `keepass-example.kdbx`: the sample database KeePass 2 creates. Root
  “Database” with two entries and six empty groups, meta name, description
  and colour, recycle bin enabled but not yet created.
- `keepassxc-example.kdbx`: Root › test › one entry with tags, expiry,
  colours, a custom icon, a plain and a protected custom field, an `otp`
  URI, two attachments and history; public custom data with a colour.
  Made with KeePassXC; the custom icon and the image attachment were then
  replaced with one-colour squares (kdbxweb), so the file holds no
  third-party images.
- `keeman-sample.kdbx`: covers what the other two lack. Five group levels,
  history with three states, `{REF}` placeholders, every OTP variant of
  the import (KeePassXC URI is in `keepassxc-example.kdbx`; here `TimeOtp-*`
  in Base32, hex, Base64 and UTF-8, `TOTP Seed`/`TOTP Settings`, KeeOtp,
  HOTP and Steam), awkward field names, tags with `:` and tabs, a tab in
  notes, an expiry date, a recycle bin with an entry and a group carrying
  `PreviousParentGroup`, `HistoryMaxItems = -1`, and three custom icons:
  a red 16 × 16 PNG named “Red square” (group Nordhost and a snapshot of
  root web01), an unused blue one and one whose data is no image (Odd
  fields).

## Regenerating `keeman-sample.kdbx`

Edit `keeman-sample.xml`, then (KeePassXC 2.7, password `test` twice):

```bash
rm keeman-sample.kdbx
keepassxc-cli import -p -t 100 keeman-sample.xml keeman-sample.kdbx
```

KeePassXC sorts tags and assigns a new database UUID; the tests do not
depend on either.

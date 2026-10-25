# Third-party notices

KeeMan Web Client bundles the following works whose licences ask for a
notice. The full list of dependencies with their licences is in
`pnpm-lock.yaml` (`pnpm licenses list`).

## Lucide icons

Built-in icons (`apps/web`, package `lucide`).

ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## EFF Long Wordlist

Passphrases of the password generator
(`packages/core/src/generator/eff-wordlist.ts`).

"EFF Long Wordlist" by the Electronic Frontier Foundation
(https://www.eff.org/dice), licensed under CC BY 3.0 US
(https://creativecommons.org/licenses/by/3.0/us/). Changed: the four words
containing a hyphen were removed.

## fractional-indexing

Sort keys (`packages/core`, package `fractional-indexing`), CC0-1.0
(public domain dedication) by Rocicorp; no notice required, named for
completeness.

## kdbxweb

KDBX import and export (`packages/core/src/kdbx/file`, package `kdbxweb`
2.1.1). Changed by `patches/kdbxweb@2.1.1.patch`: the bundled webpack helper
no longer calls `new Function`, tabs survive XML parsing, and tags are not
split at colons.

MIT License

Copyright (C) 2021 Antelle

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## fflate

Gzip inside KDBX files; bundled in `kdbxweb`. MIT License,
Copyright (c) 2020 Arjun Barrett. Licence text as for kdbxweb above.

## @xmldom/xmldom

XML parser for KDBX in the worker (via `kdbxweb`, override to 0.8.15).
MIT License, Copyright 2019 - present Christopher J. Brody and other
contributors; Copyright 2012 - 2017 @jindw and other contributors. Licence
text as for kdbxweb above.

## hash-wasm

Argon2 for KDBX files (`packages/core/src/kdbx/file`, package `hash-wasm`).
MIT License, Copyright (c) 2020 Dani Biró. Licence text as for kdbxweb above.

## jsQR

Reading QR codes from images (`apps/web`, package `jsqr` 1.4.0), loaded only
when a QR code is imported. By Cosmo Wolfe and contributors
(https://github.com/cozmo/jsQR), licensed under the Apache License,
Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0); the licence text
is included in the package. Unchanged.

## QR Code Generator for JavaScript

Drawing the QR code of the account TOTP (`apps/web`, package
`qrcode-generator` 2.0.4), loaded only when TOTP is set up. Copyright (c)
2009 Kazuhiko Arase (http://www.d-project.com/), MIT License. Licence text
as for kdbxweb above. Unchanged. "QR Code" is a registered trademark of
DENSO WAVE INCORPORATED.

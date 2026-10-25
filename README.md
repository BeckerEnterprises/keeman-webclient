# KeeMan Web Client

Web client for [KeeMan](https://www.keeman.org), a self-hosted zero-knowledge password manager with a KeePassXC-like user experience. All encryption and decryption happens here, in the browser; the server only ever sees ciphertext.

First things first: Keeman is vibe-coded!

This is a pnpm workspace:

| Package                          | Purpose                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| `packages/core` (`@keeman/core`) | Client core: crypto, data model, sync, API client. No Vue, no DOM. |
| `apps/web` (`web`)               | Vue 3 web app                                                      |

> **Status:** early development. Do not use with real passwords yet.

## Development

Needs Node.js 24 or later and pnpm 12 (`corepack enable` picks the version from `package.json`); deployment also uses `rsync`.

```bash
pnpm install
pnpm check            # lint, format, typecheck, unit tests, audit
pnpm --filter web dev # http://localhost:5173
```

The app reads its API URL at runtime from `/config.json` (`apps/web/public/config.json` for local development, not in git):

```json
{ "apiUrl": "http://localhost:8787" }
```

Run a [KeeMan server](https://github.com/BeckerEnterprises/keeman-server) on that port with `http://localhost:5173` in `allowed_origins` (its `init --dev` writes such a configuration).

The core passes the test vectors in `packages/core/test/vectors/data/`, which every KeeMan client and the server share. `packages/core/src/api/openapi.gen.ts` holds the API types; the maintainers generate it from the API contract together with each API change, so do not edit it by hand.

### End-to-end tests

```bash
KEEMAN_SERVER_DIR=/path/to/keeman-server pnpm --filter web e2e   # or KEEMAN_SERVER_BIN=/path/to/keeman-server
```

The tests need a KeeMan server: `KEEMAN_SERVER_BIN` names a built `keeman-server` binary, `KEEMAN_SERVER_DIR` a checkout of the server repository, which is built first. The setup starts it on `http://localhost:18787` with its own temporary data and serves the build with `vite preview` on `http://localhost:4173` with the production CSP. Every test fails on CSP violations, requests to other hosts and browser storage outside the allowed keys. Browsers once: `pnpm --filter web exec playwright install chromium firefox` (system libraries: `playwright install-deps`, needs root).

### KDBX checks with KeePassXC

The core tests let `keepassxc-cli` (KeePassXC 2.7, e.g. the Debian package `keepassxc-minimal`) read the KDBX fixtures and our exports as an independent check. Without it these tests are skipped; `pnpm --filter @keeman/core test:keepassxc` fails instead. The fixtures and how to regenerate them are described in `packages/core/test/fixtures/kdbx/README.md`.

`kdbxweb` is patched (`patches/kdbxweb@2.1.1.patch`, see `THIRD-PARTY-NOTICES.md`); keep the patch when updating.

## Deployment

`scripts/deploy.sh` runs from a clean working tree: tests, build, a scan of `dist/`, then it copies the files into the web root (directories 0755, files 0644; assets first, `index.html` last), creates `config.json` if it is missing and checks the security headers of the delivered site:

```bash
KEEMAN_WEB_DIR=/var/www/keeman KEEMAN_SITE_URL=https://app.example.org \
KEEMAN_API_URL=https://api.example.org scripts/deploy.sh
```

Run it as an account that owns the web root. The API server's user must not be able to write these files: whoever can replace the JavaScript can capture master passwords. Do not put a CDN or proxy that can change content in front of the web client.

The web server sets the security headers; `connect-src` names the API. With Caddy:

```caddyfile
app.example.org {
	root * /var/www/keeman
	encode zstd gzip

	header {
		Content-Security-Policy "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://api.example.org wss://api.example.org; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'"
		Strict-Transport-Security "max-age=63072000"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "no-referrer"
		Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self), publickey-credentials-create=(self)"
		Cross-Origin-Opener-Policy "same-origin"
		Cross-Origin-Resource-Policy "same-origin"
	}

	# "header" runs before "try_files": no-cache for everything but /assets/*,
	# otherwise deep links could get a stale index.html after a deploy.
	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"
	@notassets not path /assets/*
	header @notassets Cache-Control "no-cache"

	try_files {path} /index.html
	file_server
}
```

The web client and the API must be on the same site (for example `app.example.org` and `api.example.org`), because the refresh cookie is `SameSite=Strict`.

### Container

`Dockerfile` builds the app and serves it with Caddy on port 8080, without TLS, as a non-root user. The image sets the same security headers as above; `KEEMAN_API_HOST` fills `connect-src` and `config.json`:

```bash
podman build -t keeman-webclient .                         # or docker build
podman run -d -e KEEMAN_API_HOST=api.example.org -p 127.0.0.1:8080:8080 keeman-webclient
scripts/check-image.sh                                     # builds, starts and checks the headers
```

Put a reverse proxy with TLS in front. The server repository has a compose example that runs the API, this image and Caddy together.

The source links (AGPL §13) are build constants in `apps/web/src/build-info.ts`. If you run a modified version for others, point them at your own repositories.

## License

[GNU Affero General Public License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`).

Bundled third-party works with notice requirements (Lucide icons, the EFF word list) are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The KeeMan name and logo (including `apps/web/public/favicon.png`) are not licensed under the AGPL: as permitted by section 7(e) of the license, no rights to use them are granted. If you distribute or run a modified version for others, give it your own name and logo.

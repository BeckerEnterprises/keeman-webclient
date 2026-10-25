#!/usr/bin/env bash
# Builds the web client, installs it into the web root and checks the
# security headers of the delivered site. Run it as the account that owns the
# web root; the files must not be writable for the API server's user, or a
# flaw in the API could replace the JavaScript that sees master passwords.
#
#   KEEMAN_WEB_DIR=/var/www/keeman \
#   KEEMAN_SITE_URL=https://app.example.org \
#   KEEMAN_API_URL=https://api.example.org \
#     scripts/deploy.sh
set -euo pipefail

WEB_DIR="${KEEMAN_WEB_DIR:?web root of the web client, e.g. /var/www/keeman}"
SITE_URL="${KEEMAN_SITE_URL:?address of the web client, e.g. https://app.example.org}"
API_URL="${KEEMAN_API_URL:?address of the API, e.g. https://api.example.org}"

cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo "error: uncommitted changes; the source link must match the deployed code" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm -r test
pnpm --filter web build
node apps/web/scripts/check-dist.mjs
# A local public/config.json must never be shipped.
rm -f apps/web/dist/config.json

# Assets first, index.html last, old files removed at the end.
rsync -a --chmod=D755,F644 --exclude index.html --exclude config.json \
  apps/web/dist/ "$WEB_DIR/"
rsync -a --chmod=F644 apps/web/dist/index.html "$WEB_DIR/index.html"
rsync -a --delete-after --chmod=D755,F644 --exclude config.json \
  apps/web/dist/ "$WEB_DIR/"

if [ ! -e "$WEB_DIR/config.json" ]; then
  printf '{ "apiUrl": "%s" }\n' "$API_URL" >"$WEB_DIR/config.json"
  chmod 0644 "$WEB_DIR/config.json"
  echo "created $WEB_DIR/config.json"
fi
echo "deployed $(git rev-parse --short=12 HEAD) to $WEB_DIR"

node apps/web/scripts/check-headers.mjs "$SITE_URL" "$API_URL"

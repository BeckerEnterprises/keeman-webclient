#!/usr/bin/env bash
# Builds the container image, starts it and checks its security headers
# with apps/web/scripts/check-headers.mjs (the same check as after a deploy).
# Needs podman or docker.
set -euo pipefail

ENGINE="${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}"
IMAGE="${KEEMAN_IMAGE:-keeman-webclient}"
PORT="${KEEMAN_IMAGE_PORT:-18080}"
API_HOST=api.example.org

cd "$(dirname "$0")/.."
"$ENGINE" build -t "$IMAGE" .
name="keeman-webclient-check-$$"
"$ENGINE" run -d --rm --name "$name" -e KEEMAN_API_HOST="$API_HOST" -p "127.0.0.1:$PORT:8080" "$IMAGE" >/dev/null
trap '"$ENGINE" stop -t 2 "$name" >/dev/null' EXIT
for _ in $(seq 1 50); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.2
done
config="$(curl -fsS "http://127.0.0.1:$PORT/config.json")"
if [ "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).apiUrl)' "$config")" != "https://$API_HOST" ]; then
  echo "error: config.json is $config" >&2
  exit 1
fi
node apps/web/scripts/check-headers.mjs "http://127.0.0.1:$PORT" "https://$API_HOST"

# KeeMan web client as a container image: the built app served by Caddy on
# port 8080 without TLS (a reverse proxy in front terminates TLS).
#   podman build -t keeman-webclient .     (or: docker build -t keeman-webclient .)
#   podman run -e KEEMAN_API_HOST=api.example.org -p 8080:8080 keeman-webclient
# KEEMAN_API_HOST fills the Content Security Policy and config.json.

FROM docker.io/library/node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter web build \
 && node apps/web/scripts/check-dist.mjs \
 && rm -f apps/web/dist/config.json

FROM docker.io/library/caddy:2-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f
RUN addgroup -S -g 10001 keeman \
 && adduser -S -D -H -u 10001 -G keeman keeman \
 && chown -R keeman:keeman /data /config
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/web/dist /srv
USER keeman
EXPOSE 8080

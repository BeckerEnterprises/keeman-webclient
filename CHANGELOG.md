# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Container image (`Dockerfile`): the built app served by Caddy on port 8080 as a non-root user, with the same security headers as a manual setup; `KEEMAN_API_HOST` sets the API address in the Content Security Policy and in `config.json`.
- `scripts/check-image.sh`: builds and starts the image and checks its headers with `apps/web/scripts/check-headers.mjs`.

### Changed

- Updated vue-i18n to 11.4.16, lucide to 1.59.0 and eslint to 10.13.0.

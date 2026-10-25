/** Build constants. */
export const APP_VERSION = __APP_VERSION__;
export const APP_COMMIT = __APP_COMMIT__;

/** `X-Keeman-Client`. */
export const CLIENT_ID = `web/${APP_VERSION}`;

/**
 * Source code of the running version (AGPL §13). Whoever changes the
 * code builds anew and points these links at their own repositories.
 */
export const SOURCE_URLS = {
  webclient: "https://github.com/BeckerEnterprises/keeman-webclient",
  server: "https://github.com/BeckerEnterprises/keeman-server",
} as const;

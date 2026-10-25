/**
 * Security headers of the web client. One definition for
 * `vite preview` (e2e tests) and the header check of scripts/deploy.sh.
 */
export function contentSecurityPolicy(apiUrl: string): string {
  const api = new URL(apiUrl);
  const socket = `${api.protocol === "https:" ? "wss:" : "ws:"}//${api.host}`;
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${api.origin} ${socket}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

export function securityHeaders(apiUrl: string): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(apiUrl),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

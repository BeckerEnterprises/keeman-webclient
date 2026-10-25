import { execFileSync } from "node:child_process";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";
import { securityHeaders } from "./csp.ts";
import pkg from "./package.json" with { type: "json" };

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

// API origin for the CSP of `vite preview` (e2e tests use port 18787).
const previewApiUrl = process.env.KEEMAN_API_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(process.env.KEEMAN_COMMIT ?? gitCommit()),
    // Composition API only; the vue-i18n JIT compiler needs no eval.
    __VUE_OPTIONS_API__: "false",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
    __VUE_I18N_FULL_INSTALL__: "false",
    __VUE_I18N_LEGACY_API__: "false",
    __INTLIFY_PROD_DEVTOOLS__: "false",
  },
  build: {
    target: "es2022",
    // All supported browsers implement modulepreload; the polyfill would only add code.
    modulePreload: { polyfill: false },
    // libsodium (WASM inline) is large and needed by main thread and worker.
    chunkSizeWarningLimit: 1500,
  },
  // A module worker keeps import.meta.url, which the libsodium ESM build uses;
  // never inline workers (blob: URLs break worker-src 'self').
  worker: { format: "es" },
  preview: {
    host: "localhost",
    port: 4173,
    strictPort: true,
    headers: securityHeaders(previewApiUrl),
  },
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts"],
  },
});

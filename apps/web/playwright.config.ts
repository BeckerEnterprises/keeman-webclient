import { writeFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { API_URL, WEB_URL } from "./e2e/env";

// The preview serves the built app; its config.json points at the test server.
try {
  writeFileSync(
    new URL("./dist/config.json", import.meta.url),
    JSON.stringify({ apiUrl: API_URL }),
  );
} catch {
  // dist/ is missing until `vite build` ran; the e2e script builds first.
}

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 2,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: WEB_URL,
    locale: "de-DE",
    testIdAttribute: "data-test",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vite preview",
    url: WEB_URL,
    env: { KEEMAN_API_URL: API_URL },
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});

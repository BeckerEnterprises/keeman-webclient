import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: [
        "src/account/**",
        "src/api/**",
        "src/attachments/**",
        "src/crypto/**",
        "src/generator/**",
        "src/kdbx/**",
        "src/model/**",
        "src/search/**",
        "src/sharing/**",
        "src/sync/**",
        "src/placeholders/**",
        "src/totp/**",
      ],
      exclude: ["src/api/openapi.gen.ts"],
      // Each metric on its own.
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});

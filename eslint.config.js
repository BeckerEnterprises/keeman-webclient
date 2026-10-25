// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import vue from "eslint-plugin-vue";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

const noHtml =
  "Vault contents are untrusted: never render HTML. Use text bindings.";
const noVue = {
  group: ["vue", "vue-*", "@vue/*", "pinia"],
  message: "@keeman/core must not depend on Vue.",
};
const noLibsodium = {
  name: "libsodium-wrappers-sumo",
  message: "Only src/crypto/sodium.ts imports libsodium.",
};
const noStorage =
  "Only apps/web/src/storage.ts uses browser storage, with its allowed keys.";
const noKdbxLibs = {
  group: ["kdbxweb", "kdbxweb/*", "hash-wasm", "hash-wasm/*"],
  message:
    "kdbxweb and hash-wasm are used only in src/kdbx/file, inside the KDBX worker.",
};
const noInternal = {
  group: ["**/internal/*", "**/internal"],
  message:
    "crypto/internal (fixed randomness, raw blob writer) is for tests only.",
};

export default defineConfig(
  {
    ignores: [
      "**/dist/",
      "**/coverage/",
      "packages/core/src/api/openapi.gen.ts",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  vue.configs["flat/recommended"],
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
      },
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // Security rules for all code: vault contents are never rendered as HTML.
    rules: {
      "vue/no-v-html": "error",
      "no-restricted-properties": [
        "error",
        { property: "innerHTML", message: noHtml },
        { property: "outerHTML", message: noHtml },
        { property: "insertAdjacentHTML", message: noHtml },
        { object: "document", property: "write", message: noHtml },
        { object: "document", property: "writeln", message: noHtml },
        ...["localStorage", "sessionStorage", "indexedDB"].map((property) => ({
          object: "window",
          property,
          message: noStorage,
        })),
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  {
    // The core runs in browsers, workers and Node: no Vue, no DOM, no browser storage.
    files: ["packages/core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [noVue] }],
      "no-restricted-globals": [
        "error",
        ...[
          "window",
          "document",
          "localStorage",
          "sessionStorage",
          "indexedDB",
        ].map((name) => ({
          name,
          message: "@keeman/core must not use DOM or browser storage APIs.",
        })),
      ],
    },
  },
  {
    // Only sodium.ts touches libsodium; crypto/internal stays out of the sources.
    files: ["packages/core/src/**/*.ts"],
    ignores: ["packages/core/src/crypto/sodium.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [noLibsodium], patterns: [noVue, noInternal, noKdbxLibs] },
      ],
    },
  },
  {
    // The KDBX file layer runs in its own worker: kdbxweb and hash-wasm only
    // here, and no libsodium, sync or API client.
    files: ["packages/core/src/kdbx/file/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [noLibsodium],
          patterns: [
            noVue,
            noInternal,
            {
              group: [
                "**/crypto/*",
                "**/crypto",
                "**/sync/*",
                "**/sync",
                "**/api/*",
                "**/api",
                "**/account/*",
                "**/sharing/*",
              ],
              message: "src/kdbx/file has no libsodium, sync or API client.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/core/src/crypto/sodium.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [noVue, noInternal] }],
    },
  },
  {
    files: ["packages/core/src/crypto/**/*.ts"],
    rules: { "no-console": "error" },
  },
  {
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.vue"],
    languageOptions: { globals: globals.browser },
    // TypeScript checks undefined names; the core rule does not know DOM types.
    rules: { "no-undef": "off" },
  },
  {
    // The app uses the public API of the core; browser storage only via storage.ts.
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.vue"],
    ignores: ["apps/web/src/storage.ts", "apps/web/src/storage.test.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...["localStorage", "sessionStorage", "indexedDB", "caches"].map(
          (name) => ({ name, message: noStorage }),
        ),
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@keeman/core/src/*", "**/packages/core/**"],
              message: "Use the public entry points of @keeman/core.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);

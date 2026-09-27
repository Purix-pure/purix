// eslint.config.mjs
//
// Type-aware lint across all three workspace packages. Each package gets
// its own languageOptions.project pointing at its own tsconfig.json, since
// they don't share one root tsconfig.
//
// IMPORTANT: packages/cli and packages/mcp-server import @purix/core/*,
// which resolves through packages/core's `exports` map to `dist/*` — so
// those two packages only type-check correctly once packages/core has been
// built at least once. Run `pnpm run build` before `pnpm run lint` on a
// clean checkout (the `lint` script in package.json does this for you).
//
// Test files (**/*.test.ts) get no-floating-promises and require-await
// turned off: this repo's tests use node:test's describe/it/beforeEach,
// which return promises that the test runner registers and awaits
// internally. @typescript-eslint has no built-in awareness of that
// registration pattern, so it flags every describe/it/hook call as an
// unhandled promise. That's a false positive specific to node:test, not a
// real bug — keep the rule live for everything else so it still catches an
// actual dropped promise in gates/, sandbox/, mcp handlers, etc.
import tseslint from "typescript-eslint";

const packages = ["core", "cli", "mcp-server"];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/core/src/language/conformance/fixtures/**",
    ],
  },
  ...packages.map((pkg) => ({
    files: [`packages/${pkg}/src/**/*.ts`],
    languageOptions: {
      parserOptions: {
        project: `./packages/${pkg}/tsconfig.json`,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    extends: [...tseslint.configs.recommendedTypeChecked],
    rules: {
      // Errors — real-bug-risk rules, kept strict
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/require-await": "error",
      "no-empty": "error",
      "@typescript-eslint/unbound-method": "error",
      "no-useless-escape": "error",
      "preserve-caught-error": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "no-useless-assignment": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "prefer-const": "error",

      // Warnings — real for MCP-tool-handler `any` flow, not blocking a build yet
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
    },
  })),
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
);

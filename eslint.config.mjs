// eslint.config.mjs: the flat config ESLint 9 requires. `pnpm run lint` (and the publish workflow) run `eslint .` from the repo root.
// Deliberately light: TypeScript's own recommended rules, nothing stylistic. Style is not what blocks a release; real bugs are.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/.purix/**",
      "**/.purix-tmp*/**",
      "**/fixtures/**",
      "**/conformance/fixtures/**",
      "opencode/**",
      "**/.agents/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    // CommonJS files (.cjs) have no other way to load a module than require(); forbidding it there is forbidding the file.
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["**/*.{ts,mts,cts,js,mjs,cjs}"],
    rules: {
      // Warn, not fail: the codebase has existing `any` in adapters and tests. Tighten later, on purpose, not as a release blocker.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
);

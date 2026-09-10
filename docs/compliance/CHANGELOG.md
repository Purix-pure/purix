# Changelog

All notable changes to Purix are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versioning follows
[Semantic Versioning](https://semver.org/) once 1.0 ships. `@purix/core`,
`@purix/mcp-server`, and `purix` (the CLI) currently move in lockstep at the
same version number.

## [Unreleased]

### Fixed
- CLI (`purix`) entry point silently did nothing when invoked through any
  symlinked bin — `npm install -g purix`, `npx purix`, and even local
  `node_modules/.bin/purix` all go through a symlink, and the "am I the
  directly-executed entry point" guard compared a non-realpath'd
  `process.argv[1]` against a realpath'd `import.meta.url`, which never
  matched under a symlink. This affected every real install path; it did
  not affect local `tsx src/cli.ts` dev-mode invocation, which is why it
  wasn't caught earlier.
- `verify.ts`'s "TypeScript not installed" hint always suggested
  `pnpm add -D typescript` regardless of the target project's actual package
  manager. Now detects the target's lockfile (`pnpm-lock.yaml`, `yarn.lock`,
  `bun.lock(b)`, or defaults to npm) and suggests the matching command.
- Seven test files hardcoded a `packages/core/../../node_modules` path to
  find a real local `tsc`/`tsx` to spawn — correct under pnpm's non-hoisted
  `node_modules` layout, broken under npm's hoisted layout (the path simply
  doesn't exist). Centralized into `packages/core/src/test-support/real_node_modules.ts`,
  which walks up from the package directory to find the real one regardless
  of which package manager installed it.

### Changed
- **Switched the monorepo's package manager from pnpm to npm.** Rationale:
  npm ships with Node, so it's zero extra setup for anyone installing the
  published CLI or contributing to the repo. Converted `pnpm-workspace.yaml`
  → `package.json` `workspaces`, `workspace:*` protocol deps → real semver
  ranges, CI's `pnpm/action-setup` → npm's built-in `cache: 'npm'`. See
  `README.md` / `SETUP.md` for the current setup instructions.
- Renamed the CLI package from `@purix/cli` to `purix` (unscoped), for the
  shorter, more standard install/run command: `npx purix`, `npm install -g purix`.
  `@purix/core` and `@purix/mcp-server` remain scoped.

## [0.1.0] — unreleased

Initial beta scope: TypeScript and Python language support. See
[BETA_SCOPE.md](./BETA_SCOPE.md) for why Rust/Go/Ruby providers were removed
(not just gated off) for this release.

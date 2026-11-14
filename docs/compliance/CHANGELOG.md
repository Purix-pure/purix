# Changelog

All notable changes to Purix are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versioning follows
[Semantic Versioning](https://semver.org/) once 1.0 ships. `@purix/core`,
`@purix/mcp-server`, and `@purix/cli` (the CLI, command `purix`) currently move in lockstep at the
same version number.

## [Unreleased]

Nothing yet.

## [0.4.0-beta.1] — release pipeline

Same code as 0.4.0-beta.0; the version number changed so the release can go out through GitHub Actions with npm trusted publishing (and npm provenance).

## [0.4.0-beta.0] — published 2026-11-14 (by hand, without provenance)

(Labelled 0.3.0-beta.1 in earlier drafts. Nothing was ever published under that number; the version was aligned to 0.4.0-beta.0 on 2026-11-08.)

Initial beta scope: TypeScript and Python language support (JavaScript files go through the TypeScript provider). See
[BETA_SCOPE.md](../../BETA_SCOPE.md) for why Rust/Go/Ruby providers were removed
(not just gated off) for this release. Published under the npm `beta` tag: install it with `@purix/cli@beta`.

Versions `0.1.0`, `0.2.0-beta.0` and `0.3.0-beta.0` of all three packages are already on npm (September 2026) and have no entries in this file. `0.3.0-beta.1` was never published.

Everything below was tested on Linux with stubbed models. None of it has been run with a real model, a real coding agent, bubblewrap, Windows or macOS.

### Read before upgrading: `purix check` reports more than before

- After an MCP diff-ingest, files that were left untested now stay listed as "not tested" in `purix check`, the evidence bundle and `purix status`. Before, the MCP `purix_ingest` handler wrote a second verification event without the untested list, which made the earlier entry disappear and let "not tested" read as "tested".
- A write by an agent to a file no component governs is allowed and named: in the hook's stderr, as an `unadopted_write` event, and in `purix check` under "Edits made outside Purix" with outcome `skipped`. With `--strict`, `purix check` exits 1 until the file is adopted. A shell command that writes a file is not named.

### Added
- `PRIVACY.md`: what leaves the machine, what is stored, and how to delete it.
- `docs/NODE_SUPPORT_POLICY.md`: the Node range, the CI legs, and what is not covered.
- A `README.md` and a `LICENSE` file in each published package, so the npm pages and tarballs carry them.
- Root scripts `ci-bypass-flow` and `connect-harness`. `publish.yml` already called both, so a tag push would have failed at those steps.
- Secret scanning: more secret formats are recognised, and the patterns that used to only redact text from a prompt now also block a write that contains one.
- Security gate: shell scripts have their own three rules. Advisories, and the list of files the code rules did not read, are stored on the verification event and shown by `purix check`.
- Planted-tool replays: a project's own planted tool binary (for example `node_modules/.bin/eslint`) is covered by replay tests, and `PURIX_STRICT_ISOLATION=1` makes such a step refuse to run without a sandbox.
- Flaky-failure baseline compare for the TypeScript provider in the sandbox path (`BASELINE_RUNS` = 3). The dependents re-check and Python are unchanged.

### Changed
- `SECURITY.md` rewritten: supported versions, scope, the documented limitations, and how to verify a release.
- `purix index` no longer verifies each file: it lists files and records symbols, all `pending`, with result `verification: "not_run"`. `--incremental` and `--full` are not read by it; the CLI help now says so.
- The README, `SETUP.md` and `BETA_SCOPE.md` link to the privacy and security documents and state the release status.
- `docker-compose.yml` image tags updated from `0.2.0-beta.0` to `0.4.0-beta.0`.
- Package metadata (`homepage`, `bugs`, `publishConfig.access`) added to the three packages, and a description to `@purix/core`.
- Correction (2026-10-31): an earlier entry here said the monorepo moved from
  pnpm to npm and that the CLI package was renamed to `purix`. Neither is true of
  this repository. It uses pnpm 12.4.1 (`packageManager` in the root
  `package.json`, `pnpm-workspace.yaml`), and the CLI package is `@purix/cli`
  with the command `purix`. See `README.md` / `SETUP.md` for the setup.

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
- Error text sent back to a model (an MCP tool error, a provider error body) now has absolute paths, known secret formats, masked key fragments and stack frames removed (`security/error_text.ts`). (H3)
- A full disk is reported as a full disk. Before, `status`, `stats`, `lock` and `check` said the store was "damaged". (H5)
- A record or `purix.lock.json` written by a newer Purix is refused with an "upgrade Purix" message. Before, a newer record was read as current. (H4)
- A store that another Purix process holds is reported as busy ("wait a few seconds and run the command again"), not as "damaged" and not as an audit failure. Before, the start-up audit check wrote a "FAILED" status when it only met a lock. The last real audit verdict is kept. (H5)
- `purix stats --calls` no longer slows with the square of the log size (60,000 logged calls took 13 s, now under 4 s on the test machine; research 15, finding 1).
- The events table and the model-call log are pruned once a day to the last 365 days (`scheduler.logRetentionDays`). The budget and savings ledger are not touched. No roll-up row is kept for removed rows. (Research 15, finding 4)
- An event recorded while another Purix process holds the store's write lock for longer than the 5 second wait is no longer lost. It is kept in `events-pending.jsonl` next to the store and written, with its original id and time, on the next successful event or read. A spool past 1 MiB, or a store that never opened, still drops the event with a warning (research 15, finding 3). The 5 second stall itself is unchanged.
- `@purix/core` no longer exports every file. Its `exports` list names the 101 paths the CLI, the MCP server and the repository scripts import, and `pnpm run exports-check` (part of `release-check`) fails when the list and the imports disagree. Any other deep import of `@purix/core/...` stops resolving.
- The published packages no longer include source maps (they pointed at `src`, which is not published): `@purix/core` 3.1 MB to 2.0 MB unpacked.

### Removed
- The `build:bundled` script in `@purix/cli`. It pointed at `build-bundled.mjs`, which is not in the repository, and nothing else used it.

### Known gaps
- Not run anywhere: a real bubblewrap sandbox, a real model or coding agent (one OpenCode run on Windows is on file), macOS.
- The stall of up to 5 seconds when the store is busy is not shortened; only the loss of the event is fixed.
- A check that a newly added package exists (F03-03) needs a registry lookup and is not built. Dependency checks are not part of verification; `purix audit` runs on request.
- The free tier's limit of 25 tracked components is still enforced by the client, and there is no way to lift it yet.
- See [BETA_SCOPE.md](../../BETA_SCOPE.md) for the full list.

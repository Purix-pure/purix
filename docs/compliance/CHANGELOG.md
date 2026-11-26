# Changelog

All notable changes to Purix are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/); versioning follows
[Semantic Versioning](https://semver.org/) once 1.0 ships. `@purix/core`,
`@purix/mcp-server`, and `@purix/cli` (the CLI, command `purix`) currently move in lockstep at the
same version number.

## [Unreleased]

### Added (open items and decisions, 2026-11-24)
- `purix panel`: Purix line in OpenCode 1.x's sidebar (one plugin file and one `tui.json` entry; never touches what it did not write). Not checked in a live OpenCode session.
- Dashboard: `purix check` state on each project card (background, read-only, never shown as clean when it could not run) and a per-agent split on the project page.
- Python changed-line coverage through pytest-cov; pytest-cov is locked into the pinned pytest install.
- `purix lookup on|off|status` and a one-time question at the end of `purix connect`; the dependency lookup stays off until a person says yes, and the stored answer is ignored in CI.
- `docs/PR_RECEIPTS.md` (trailer plus redacted receipt; bundle on request) and `docs/BENCHMARK_PROTOCOL.md` with `scripts/benchmark-analyze.ts`.
- The R6 guard test for the dashboard folder now also forbids network clients, dynamic imports of network modules and `require`, and allows a child process only in `check_state.ts` (`execFile`, no shell).

### Added (showing what Purix did, 2026-11-24)
- `purix receipt [changeId] [--last n] [--out file] [--redact]`: one change's receipt as Markdown for a pull request, from the local record, read-only, with the chain head to compare with the `Purix-Evidence` trailer.
- Change receipt: "Changed lines", "Dependencies added" and "Rework risk" lines; a missing fact reads "not measured" or "not checked", never none. The verification event now stores changed-line coverage as counts (no file names).
- Project page: a four-week trend table and a Process panel (repairs, library reuse, changed-line coverage, landed by agent, drift accepted, notes kept, approvals by kind). `/telemetry` shows what `purix telemetry show` would send.
- Optional duplication check, `PURIX_DUPLICATION_CHECK=1`: lines of the changed files inside a repeating block of six or more lines elsewhere in the project, before and after. Local, no network, information only, never a gate.
- `/how` no longer lists finished work as "not built yet".

### Added (showing what Purix did, 2026-11-22 and 2026-11-23)
- One local record of what Purix does, read by every surface: a result line on MCP replies (`PURIX_RESULT_LINE=off` turns it off), `purix watch`, `purix statusline`, `purix dashboard` (127.0.0.1 only, read-only), `purix feedback`, and `purix digest [--days n] [--json]`. Description: `docs/OBSERVABILITY.md`.
- Stored per change: a change id, test counts and verification time, approval wait times, `change_landed`, plus events for secrets removed from prompts and replies (counts and format names, never values), dependency lookups, `purix audit` runs and rolled-back applies. A project registry (`projects.json`) in the user folder lists the projects Purix has run in.
- A change stopped by the secret scan or by a Critical or High security-gate finding stores a `policy_block` event: source, finding count, categories and up to 10 paths. Never a matched value and never message text. Nothing is written in a folder that has no store.
- `purix budget show` also says how much is left.
- The dashboard's Security panel lists what the scans look for, including the advisory scan that `purix modify` runs (rate limiting, input validation, `eval`). A test reads the scanner source files and fails when a category exists there that the list does not name.
- `purix digest` reads the same record as the dashboard. It takes no repository lock, so a change in progress does not stop it. Invalid `--days` exits 2.

### Added (2026-11-24)
- `purix statusline --install | --uninstall | --status [--shared|--user]`: adds or removes Claude Code's `statusLine` entry that runs `purix statusline`. It never replaces a status line that is not Purix's, keeps every other setting, and refuses a settings file that is not valid JSON.
- Change receipt (dashboard): a "Dependencies added" line and a "Rework risk" line. Each says "not recorded" or "too recent to judge" instead of "none" when the record cannot say.
- `purix digest` says when the record does not cover the period before (the date the record starts), and prints no "the period before" figure when the record starts inside the current period. `--json` carries `firstEventAt`.
- The result line is capped at 120 characters; the least urgent parts are dropped first.

### Changed (what the software sends or stores, 2026-11-24)
- `PRIVACY.md` now lists the dependency lookup (`PURIX_DEP_LOOKUP`, off by default) as a fourth place Purix can send package names, says what it sends and to which hosts, and describes the project list `projects.json`, the new event fields stored per project, the result line and the local dashboard. The code already did all of this; the document had said "three kinds of place" and "only when you run `purix audit`".

### Fixed
- `BETA_SCOPE.md` no longer says the free tier enforces 25 components; `licensing/tier.ts` has had no free-tier cap since 2026-11-02.
- `docs/OBSERVABILITY.md` listed built features as "not built yet".
- The CLI test suite no longer writes `projects.json` and the usage ledger into the real user folder (`PURIX_USER_DIR` is set to a temporary folder for the run).

### Not done
- OpenCode sidebar panel, changed-line coverage, an optional duplication check, pull-request receipts, and a benchmark mode. All of it was run only on Linux, Node 22, with no real model; nothing on Windows or macOS.

## [0.4.0-beta.5]

### Added (`purix start`, 2026-11-21)
- `purix start` is a guided first-run setup for a person at a terminal: choose the model provider, paste Purix's own API key at a hidden prompt, check it with one tiny request, and connect a coding agent (it runs `purix connect`, so detection and the hook offer are the same). It does not index the project and it does not touch the coding agent's own login. Decisions and evidence: `docs/research/PURIX-RESEARCH-KEY-MANAGEMENT-AND-START-2026-11-21.md`.
- `purix start` refuses to run without a terminal (stdin and stdout) and is human-only in the hook rules, because it asks for a key and decides which provider and key Purix uses.
- The provider choice can now be kept per user: `purix start` saves a default in the user folder (`provider-default.json`), so one setup covers every folder, including an MCP server an agent starts in a folder of its own choosing. Lookup order: the `PURIX_LLM_PROVIDER` variable, then the project's own `provider-config.json`, then this default. A custom endpoint is never kept there; it stays a per-project choice behind `purix provider trust`.
- If the key is in the environment, `purix start` offers to save a copy in the user-level store, because apps started outside a terminal often do not see shell variables.
- The "No LLM provider is configured" and "API key isn't available" messages now name `purix start` first. `purix start` replaces the old "There is no start step" hint.
- Not done: nothing here has run on Windows or macOS, with a real OS keyring, or with a key the provider accepts (the key check was exercised against a real provider with a made-up key, which it rejected). Linux desktop behaviour of the keyring inside an agent-started MCP server is untested (research note, open item P1).

### Changed (one credential store per user, 2026-11-21)
- `purix secret set`, `rotate` and `remove` now work on one store per person, found from the user folder and not from the folder a command runs in. A key saved in one folder is found from every folder. The store is the OS keyring (Windows Credential Manager, macOS Keychain, Linux Secret Service) through the optional package `@napi-rs/keyring`, with an encrypted file in `~/.purix` as a fallback that is announced each time it is used. On Linux the keyring is used only when a desktop session bus is present, and every keyring write is read back before it counts as stored. `PURIX_SECRET_BACKEND=file|keyring|auto` overrides this.
- A key is now looked up in the environment (including `.env`) first, then the user-level store, then this folder's old store. Before, a stored key beat the environment, so an old stored key hid a good environment key. `purix provider status`, `purix secret status` and the "key refused" note name the place the key came from and say when another place holds a different value that was not used.
- `purix secret migrate` copies keys from this folder's old store into the user-level store. It asks before copying and before removing an old copy, never overwrites a different key, and needs a person at a terminal. It is human-only in the hook rules.
- The hook rules refuse an agent's shell command or `mcp__` file tool that names a credential file or reads the OS keyring (rule `secret-read`), and any write into the user-level Purix folder. Claude Code's built-in `Read` tool is not in the registered hook matcher and is not covered.
- An old per-folder key store is now found from the folder it was saved in and from every folder below it (the nearest one wins). Before, only the exact folder Purix was run in was read, so a key saved in a project root was "not found" from its subfolders. `purix secret status` and the migration notice name the store's real location.
- The hook rule also refuses a shell command that names a credential file by its file name (`secrets.master.key`, `secrets.enc.json`, `user-secrets.enc.json`, `user-secrets.master.key`, `session.enc`) in any folder, such as another project's old store. Still a text check on the command, not a wall.
- In `auto` mode the real OS keyring is not used when `NODE_ENV=test`, when `CI` is set, or when `PURIX_USER_DIR` points Purix at a specific folder, so a test run cannot write into a developer's Credential Manager or Keychain. `PURIX_SECRET_BACKEND=keyring` still forces it.

### Changed (plain-language `purix check`, 2026-11-21)
- Every drift failure in `purix check` now ends with what to do. A deleted file says to restore it from version control, or to run `purix migration accept-drift <id>` yourself in a terminal if the deletion was intended; an edited file says to review it, then accept or revert. A next step shared by several items (for example `purix adopt` for five files an agent wrote) is printed once under the group, not once per file. `purix check --json` items gain an optional `next` field.
- The note for a file an agent wrote outside Purix no longer uses Purix's internal term "component": it says `written by an agent (<name>); not governed by Purix, so Purix did not verify it`.
- The drift warning in `purix modify` and the related commands now says when files are missing from disk instead of claiming someone edited them.
- `purix doctor` is not a command; the error now suggests `purix hooks doctor`.

### Fixed (approver and prompt messages, 2026-11-21)
- A question that nobody could answer (an agent's shell, a pipe, CI) was reported as "Bootstrap declined" or "Cancelled", as if a person had said no. The text now says no input was available, that nothing was changed, and what to do: run `purix approve --register` once in your own terminal, and use the `purix_create` / `purix_modify` MCP tools with `purix approve` for later changes.
- A webhook secret stored the documented way (`purix secret set PURIX_WEBHOOK_SECRET`) was never read, because the sender looked for the lowercase name `purix_webhook_secret`. It now reads the documented name and still accepts the old one.

### Fixed (credentials and dry-run findings, 2026-11-20)
- `purix secret set`, `rotate` and `remove` follow one rule set (`security/credential_guard.ts`): only names Purix reads are accepted, an already-stored name is refused (use `rotate`), a stored key that differs from the environment variable is refused, and a pasted value with spaces, wrapping quotes, line breaks or control characters is refused before it is stored. A provider error that suggests a bad key now says which copy was sent (stored or environment). `secret status` and `provider status` show the store location and warn about dead entries and conflicts. `purix secret set|rotate|remove` is human-only in the hook rules.
- The hidden key prompt skips terminal escape sequences, including bracketed-paste markers, so a pasted key no longer carries `[200~` or `[A` into the stored value, and it prints how many characters arrived (never the key). Reproduced on Linux with simulated input only; a Windows terminal still needs a manual check.
- `purix provider status` prints which credential store it read (superseded 2026-11-21: the store is now per user, not per folder).
- The refusal for an `unclassified` change now says what happened and how to rephrase (name the file and the intended behaviour, or split the request), instead of "cannot be applied automatically yet".
- The write-blocking secret scan no longer blocks the four credentials that AWS prints in its own documentation (`AKIAIOSFODNN7EXAMPLE`, `AKIAI44QH8DHBEXAMPLE` and their secret keys), matched exactly. The redaction path still redacts them, and a real-looking key on the same line still blocks.
- The advisory `dangerous_eval` finding no longer fires on `eval(` written in a comment or a string, or on a method that is only named `eval` (`redis.eval(`, `model.eval()`); `window.eval(`, `globalThis.eval(`, a bare `eval(` and `new Function(` still do.

### Fixed
- `purix index` read symbols with one regex over raw text (problem register 2026-11-20, items 2 to 5; reproduced on 0.4.0-beta.4 by probes IDX-01 to IDX-06). On Purix's own source that made 352 of 1,845 TypeScript entries false (text inside comments and strings, mostly fixtures in test files), 87 (name, file) pairs duplicated, and all 346 symbols in test files "reusable". The extractor is now `manifest/index_extract.ts`: the TypeScript compiler's own parser for TypeScript and JavaScript, and a string- and comment-aware scanner for Python. Measured on the same source: 0 duplicate pairs, 0 reusable entries in test files, 1,961 components (was 2,201).
- The index now records `export default`, `export enum`, `export abstract class`, `export namespace`, `export { a, b as c }`, `export * as ns`, re-exports with a name, `export var`, and the public methods of an exported class (`Class.method`, TypeScript and Python). Private, protected and `#private` members, Python names starting with `_`, and `export * from` (which names nothing) are not recorded.
- A symbol's `signature` now carries parameters, generics, heritage and return type (`export function real(a: number, b: string): boolean`), cut at 300 characters. A constant's initialiser is never copied, so a value that is a secret cannot land in `components.json`; a function-valued constant keeps its parameters and return type.
- `reusable` now means what the indexer can check: the symbol is exported and its file is not a test file (the same `isTestPath` and `isPythonTestPath` rules the verifier uses). The field keeps its name: renaming it needs a manifest migration, and who owns `manifest/` is an open ruling (D-l).
- `purix index` said only "N file(s) ... left out". It now says which file types (`Left out by type: 90 .json, 60 .md ...`), and `purix index --list-skipped` lists every file. The result carries `unsupportedFiles`; the MCP `purix_index` result carries `unsupportedByExtension` instead of hundreds of paths.
- `purix status --detail full` and `purix status --json` were "unknown option". Both now print every manifest entry as JSON, the same text the MCP tool `purix_status` returns for detail "full". `--detail concise` and the default are unchanged. A bad level, or `--json` with `--detail concise`, exits 2 (invalid usage).

### Changed
- The note `purix connect` writes into an agent's instruction file now names every tool the server offers (purix_create, purix_adopt, purix_remember, purix_ingest and the tool broker were missing), says to keep each change small, and tells an agent to call again with `componentId` when several components match. The model prompts and their golden file were aligned with the same set (`purix-llm-alignment.patch`, applied as given).

### Known, not changed
- The index still records no import edges between files (register item 1). Storing them changes the manifest, which is under the open ruling D-l, and the register's own research (RepoGraph, ICLR 2025) measured a different, line-level graph on Python repositories, so it is not evidence for a Purix design. It needs that ruling and a `purix eval` before and after.
- `rationale` stays empty and every entry stays `pending` at index time (register item 6, probe IDX-08). Verifying each file at index time cost about 1.5 s per file, which is why it was removed; the indexer header says so. `purix index --why` does not exist.

## [0.4.0-beta.4]

### Changed
- `purix secret set <name>` and `purix secret rotate <name>` now ask for the value (hidden prompt on a terminal) or read it from stdin, so the key never has to be typed on the command line, where it is saved in shell history and visible in `ps`. The old form with the value as an argument still works and now prints a warning. Hints elsewhere no longer tell people to type the key as an argument.

### Fixed
- `purix lang verify` put its scratch workspace under the folder found by walking up from the Purix module's own location (reproduced: run from another project, it wrote into the Purix source tree; for an installed copy it could reach any enclosing project that has a `.git` or `pnpm-workspace.yaml`), not under the folder it was run in. It now uses `.purix/tmp/conformance/` in the current folder, as CI already did. The install message no longer names a path that was not the real install location.
- `SECURITY.md`, `PRIVACY.md` and the compliance notes named the removed commands `secret-set` and `secret-rotate`; they now name `purix secret set` and `purix secret rotate`.
- Removed 31 unused imports (lint warnings 186 to 155; errors stay at 0).

## [0.4.0-beta.3]

### Fixed
- The repository is now spelled `Purix-pure/purix`, GitHub's own spelling, in `server.json` (name and repository), both `mcpName` fields, the three packages' homepage and issues links, and the brand default. npm provenance and the MCP registry both compare it case-sensitively. `version-check` now fails on a case difference and also checks `mcpName`.
- A blocked name with an empty value in a project `.env` (`PURIX_QUIET=`) no longer produces the "ignored" notice, since it could not change anything.
- `.env.example` now holds only what a project `.env` may set (provider keys, per-provider model names); the shell-only Purix settings are listed as comments, and the header no longer claims every value reaches Purix or names the old `secret-set` and `provider-set` commands.
- The "ignored ... from ./.env" notice no longer prints on every command. It shows once per folder and per set of names, and again if the `.env` gains a new blocked name. The names are still ignored on every run; only the notice is remembered (`env-notice.json` in the Purix user folder).

- `purix_create` checks that an approver is registered **before** it calls the model. It used to check afterwards, so a fresh project paid for a model call and was then told to run `purix approve --register`.
- `purix_change` offers to adopt an indexed file that no component owns (as `purix change` does) instead of proposing a duplicate component with a name made up from the sentence. It points to `purix_adopt`; adopting still needs a person.
- `@purix/mcp-server` failed to build: the stdio entry file added for the no-prompt end-to-end test sat in `src/` and was compiled into the published package. `tsconfig.build.json` now excludes `src/**/*_server.ts`; the test still runs it from source.
- `purix_modify` now does what `purix modify` does first: it reads the recorded conventions and notes for the component and has the model restate the instruction before classifying. The restated instruction and its assumptions are recorded in the classification event. This is **one more model call** per modify over MCP.

### Added

- `purix_remember` (MCP): an agent can record a convention or decision. One plain statement, at most 500 characters, refused if it reads as an instruction to a model or contains hidden characters, saved as an `agent-note`, at most 20 per session, audited as `memory_recorded`. It reverses the 2026-10-14 decision (MCP-5) that moved `remember` to the CLI only; `purix remember` and the tool share one function.
- Creating a component shows the planner the recorded conventions and the ids of existing components, tells it `depends_on` may only use those ids, retries once on an invented id, and drops what is still invented. After a create lands, one `create` memory line records what the component is for and what it depends on.
- A change shows the model the neighbouring components' files (read-only, inside the existing neighbour token budget, secrets redacted, injection-screened) on the **first** classification, not only in escalation after a failure. Expect more input tokens per modify on components that have neighbours.
- When a request names no component and a new one is about to be proposed, `purix change` and `purix_change` name the existing components it resembles (suggestion only, no model call). Ranking is BM25 over each component's id, file names and recorded purpose notes, so the purpose line a create writes makes the component findable by what it is for; one shared module (`entrypoints/briefing.ts`) supplies conventions, existing ids and similar components to create, change and both doors. On 12 hand-written cases the top three held the right component 10 times, against 9 for the word overlap it replaces (small synthetic set, not a real-project recall figure).
- The approval text for an MCP modify shows how the model read the instruction (`Interpreted as: ...`, plus assumptions) when that differs from what the agent sent. Model text is cut to one line, control and hidden direction characters removed.

### Changed

- `purix remember` no longer writes an identical note twice, and trims the note.
- `.gitattributes`: `*.zip` and web fonts are binary; `*.cmd` and `*.bat` use CRLF.

## [0.4.0-beta.2]

### Fixed

- The MCP server no longer asks a question on its own stdin/stdout. Before, the first gated call on a fresh project (for example `purix_create`) reached the "register you as the sole approver?" prompt, wrote it into the reply stream and read the agent's next request as the answer, so that call and every later one timed out (-32001). The server now refuses to prompt, treats the question as "no", and tells the person to run **`purix approve --register`** in a terminal. Library promotion during escalation is skipped (and recorded as skipped) where nobody can be asked, instead of failing a fix that already passed verification.

### Added

- `purix approve --register`: the one-time step that records who may approve. It needs a person at a terminal.

### Changed

- A command line Purix cannot use (unknown command, unknown option, missing or extra argument, a command group run with no subcommand) now exits **2**, the code the exit map reserves for invalid usage. It exited 1 before, the same as a failed check. `--help` and `--version` still exit 0.
- Release tooling (no change to what the packages do): `scripts/sync-versions.mjs` (`pnpm run version-check` / `version-set`) fails when a release version, pnpm pin, Node range or repository URL disagrees between the files that write it; the eight dependencies shared by more than one package now live once in the pnpm `catalog:` in `pnpm-workspace.yaml`; `scripts/check-registry.mjs` asks npm before publishing (version not already taken, tag fits) and after (all three packages, dist-tag, provenance, fresh install).

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

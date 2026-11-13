# Purix Testing Plan, Release 1

2026-11-12 (revised from 2026-11-04 against the code in packages.zip). Covers the whole path from a developer's machine to real users. Step 1 is the automated suite that already exists and was updated today. Steps 2 to 5 finish the offline testing. Steps 6 to 8 are the real-time testing (real agents, a real model, real people).

**How to read the status column.** *Built* means it exists in the repository and I ran it today. *Updated* means it existed and I changed it today. *New* means I wrote it today. *To build* means it does not exist yet; I give the design but have not run it.

## 1. What real software companies do, and what Purix takes from it

I looked for published studies and engineering books from large companies. Each row says what they found, and what Purix does because of it.

| Finding | Source | What Purix does |
| --- | --- | --- |
| Tests are sorted by what they are allowed to use (small = one process, medium = one machine, large = anything), not only by what they cover. The book's rough mix is 80% narrow tests, 15% medium, 5% whole-system, by count, and it says each team's balance will differ. | *Software Engineering at Google*, ch. 11 | Steps 1 and 2 keep a large base of fast offline tests. Whole-system tests (flows, real agents) stay few. The 80/15/5 mix is a starting guess, not a target. |
| About 1.5% of all test runs at Google gave a flaky result (pass and fail on the same code), almost 16% of tests had some flakiness, and 84% of pass-to-fail changes involved a flaky test. | Google Testing Blog, J. Micco, 2016 | Step 2 repeats the suite many times and names every test that fails even once. Purix has about 1,830 tests in the three package suites (core 3,035 in the full run, mcp-server 143, cli 298 on 2026-11-12; an earlier figure of core 1,410 counted only the tests outside the coverage-gated folders), so one flaky test is still a small, visible fraction. |
| Google runs mutation testing only on the lines a change touches, hides mutants in places not worth testing (such as logging), and shows survivors in code review. Usefulness reported by developers rose from about 20% to about 80% once they could give feedback on mutants. Developers using it wrote more tests over time. | Petrović and Ivanković, ICSE-SEIP 2018; Fraser, Ivanković, Just et al., ICSE 2021 and IEEE TSE 2021 | Step 2 adds change-based mutation testing. It checks that the tests would notice a wrong change, which line coverage cannot show. |
| Meta picks which tests to run per change with a model trained on past results: over 99.9% of faulty changes still caught, about half the infrastructure cost. | Machalica et al., *Predictive Test Selection*, ICSE-SEIP 2019 | Not needed yet. Purix's whole suite is small enough to run. Revisit if the suite grows past what a pull request can afford. |
| Mozilla measures each performance change several times and tests the difference statistically, because one run is mostly noise. Chromium sets explicit thresholds per test. | Mozilla Perfherder studies (arXiv, 2025 and 2026); Chromium performance docs | The speed test judges the median of several runs, uses explicit budgets, and can compare against a baseline from the same machine. |
| 0.1 s feels instant, 1 s keeps the user's flow of thought, 10 s is the limit of attention. These limits have not changed in decades. | Nielsen, *Response Times: The 3 Important Limits* | Speed budgets are set from these limits, not from what Purix happens to do today. |
| Passing tests do not prove reliability but failing tests prove its absence. Smoke tests short-circuit costlier ones. Production tests, configuration tests, stress tests and canaries cover what offline tests cannot. A canary is "structured user acceptance" rather than a test. "If you haven't tried it, assume it's broken." | Google *SRE Book*, ch. 17 | Step 1 starts with the cheapest checks. Steps 5 to 8 are the "try it" steps: install it, run real agents, release to a few people first. |
| An eval is a task plus grading logic. Separate capability evals (can it do this?) from regression evals (does it still?). Grade the outcome, not the exact steps. Run each task more than once: pass@k (succeeds at least once in k tries) hides unreliability that pass^k (succeeds every time) shows. Read transcripts. | Anthropic Engineering, *Demystifying evals for AI agents*, Jan 2026 | Steps 6 and 7 follow this for the agent and model runs. |

**What these sources do not tell me.** I did not find a published study specific to testing command-line tools that sit between an AI agent and a codebase. I applied general practice. The mutation-testing tool I propose has not been tried in this repository yet. The Google numbers date from 2016 to 2021. The pyramid ratio I read through summaries of the book, not the chapter text itself.

## 2. The eight steps

| Step | Name | Question it answers | Where it runs | Status |
| --- | --- | --- | --- | --- |
| 1 | Automated suite | Does the code do what we wrote, and is it fast enough? | One machine, offline | Built, updated |
| 2 | Trust in the tests | Would the tests notice a wrong change? Do they give the same answer every time? | One machine, offline | Partly built |
| 3 | Failure and attack | What happens when things break or someone tries to get around Purix? | One machine, offline | Partly built |
| 4 | Other machines | Does it behave the same on Windows, macOS and each supported Node? | CI and real machines | Partly built |
| 5 | Install like a user | Does what we publish install and run for a stranger, and can we undo a bad release? | Clean machine, real npm | Partly built |
| 6 | Real agents | Does a real coding agent actually load the hook and call the tools? | Real agent | To run |
| 7 | Real model quality | When a real model proposes changes, how often is Purix right? | Real model, budget-capped | Harness built, real run to do |
| 8 | Real people and value | Does it save developers time and tokens, and do they get stuck? | Real developers | To build |

**The rule between steps.** Steps 1 to 5 use no real agent, no real model, no real user. Steps 6 to 8 do. Do not start step 6 until the exit gates of steps 1 to 5 are met, because a real-time failure is expensive to read when an offline cause is still possible.

## 3. Step 1: Automated suite (Built, updated)

**One command:** `pnpm run test:all` (same as `node scripts/purix-04-run-all.mjs`). It runs every stage once, writes one log per stage under `.test-logs/<time>/`, and ends with `SUMMARY.md`. `--list` shows the plan. `--skip slow` leaves out the slow groups. `--only speed` runs just the speed stages. `--serial` runs one test file at a time (use it on Windows). `--strict-known` makes a known failure fail the run too. `summary.json` next to `SUMMARY.md` has the same result for a machine to read.

**Rule kept from the existing runner:** every stage tests a different thing, and the runner refuses to start if two stages claim the same thing.

| ID | Stage | What it checks | Fails when | Status |
| --- | --- | --- | --- | --- |
| 1.1 | machine-facts | Records Node, pnpm and git versions | A tool is missing | Built |
| 1.2 | install-frozen | Dependencies install exactly from the lockfile | Lockfile and package files disagree | Built |
| 1.3 | boundary-check | `core` never imports `cli` | A forbidden import appears | Built |
| 1.4 | single-point-check (+ its own tests) | No new scattered console, fetch, env or `.purix` use (ADR-061) | The count grows past the baseline | Built |
| 1.5 | env-docs-check (+ its own tests) | Every environment variable the code reads is in `docs/ENVIRONMENT.md` | A variable is undocumented | Built |
| 1.6 | import-cycle-check (+ its own tests) | No circular imports | A cycle appears | Built |
| 1.7 | tool-boundary-check (+ its own tests) | Tools install only through the broker (ADR-060) | Another install path appears | Built |
| 1.8 | artifact-check | No build junk committed | A build artifact is tracked | Built |
| 1.9 | claim-ledger | Every public claim still exists with its evidence; no banned phrase | A claim lost its evidence | Built |
| 1.10 | checks-page | `docs/WHAT_PURIX_CHECKS.md` is what the claims register says now | The page is out of date | Built |
| 1.11 | typecheck | Types, all packages | Any type error | Built |
| 1.12 | lint | Lint rules | Any lint error | Built |
| 1.13 | build | Packages build (later stages need `dist/`) | Build error | Built |
| 1.14 | speed-commands | Every command's `--help` and real run, the agent hook, and the MCP server, against budgets | A median is over budget, a command exits wrongly, or a command exists that the test was never told about | Built |
| 1.15 | speed-scale | `purix index` on 500, 2,000 and 8,000 files, on a plain folder and inside a git repository, grows about in step with the project | Slope over the limit, largest run over budget, or one run over the abort time | Updated (no longer a known failure) |
| 1.16 | core-suite | Core tests, except the folders the coverage gate owns | Any test fails | Built |
| 1.17 | mcp-server-suite | Approval, path containment, elicitation round trip | Any test fails | Built |
| 1.18 | cli-suite | Commands, read-only commands, MCP stdout purity, integration, hook end-to-end | Any test fails | Built |
| 1.19 | no-leftover-state | No `.purix` under `packages/` and no new untracked file after the suites | A test wrote into the source tree | New (syntax and listing checked only) |
| 1.20 | coverage-gate-90 | 90% lines, branches and functions on `llm`, `licensing`, `gates`, `sandbox`, `verify` | Under 90% on any of the three | Built |
| 1.21 | language-conformance | TypeScript and Python checks give the same answers | A parity difference | Built |
| 1.22 | ci-lock-flow | `purix lock` then `check --strict` on a fresh checkout; an edit is caught | Any step differs | Built |
| 1.23 | ci-hook-flow | Hook payloads of six agents against a project made by the real CLI | A governed edit is allowed or an unreadable payload is not blocked | Built |
| 1.24 | ci-bypass-flow | Simulated agent: hooks installed block a direct edit; uninstalled, it lands and `check --strict` names it | Either half differs | Built |
| 1.25 | connect-harness | For every supported agent, the written config starts a server that answers (config level only) | Any agent's check fails | Built |
| 1.26 | mcp-smoke-test | Real MCP server over stdio: handshake and tool calls | Handshake or call fails | Built |
| 1.27 | release-only-checks | Pack, clean install in a folder with spaces and non-ASCII (index, adopt, lock, strict check on a fresh checkout, an edit is caught), versions, tarball contents, workflow parity, audit, SBOM | Any of them differs | Updated |
| 1.28 | windows-real-machine | Launchers, CRLF, BOM, locked files, killed server, secret permissions | Windows only | Built |
| 1.29 | dependency-audit-detection | The audit really finds a known vulnerable package (live npm and pip) | Needs `--network` | Built |

Stage ids are the position in the runner's list (`node scripts/purix-04-run-all.mjs --list`), so this table and the runner cannot drift unnoticed. A misspelt `--only` group is now an error, not an empty green run.

**What I ran on 2026-11-12 (Linux, one CPU, Node 22.23.4):** stages 1.2 to 1.10 and 1.12 passed. 1.11 failed on one stale file, `packages/cli/src/cli/commands/index_headline.test.ts`, which plan v6 says to delete; it was deleted. 1.14 passed (141 items) and 1.15 passed (slope 0.36 plain folder, 0.40 git repository). Suites (counted then; the full-run figures on the final tree are core 3,035, mcp-server 143, cli 298): core 1,410 tests, mcp-server 133, cli 285, all passing, and no `.purix` left under `packages/`. 1.22 to 1.26 passed, as did the pack, clean-install, SBOM and audit parts of 1.27. **Not run in this pass:** 1.19 end to end, 1.20, 1.21, 1.28, 1.29, and anything on Windows or macOS.

### The speed test in detail (1.11 and 1.12)

It replaces `scripts/benchmark-cli-help.mjs`. That script only timed `--help`, never ran a command, had no pass or fail limit, and listed about 44 commands by hand while the CLI has more than 80 (it missed `check`, `lock`, `evidence`, `hooks`, `budget`, `telemetry`, `approve` and most `tools` subcommands). I checked that an unknown command run with `--help` still exits 0 and prints the parent's help, so a renamed command would have been timed without any warning.

**What it times** (wall-clock time of the real built CLI, as a user or an agent hook would run it):

| Part | What | Class of budget |
| --- | --- | --- |
| Commands | `--version`; `--help` of every command found in the CLI (83 today, hidden ones included); the real run of 31 read-only commands; 13 light-write commands; the `index`, `adopt`, `lock` chain on a fresh project each run | version, help, read, write, index-small |
| Hooks | `purix hook claude-code pre-tool-use` for a blocked edit, an allowed edit, and an unreadable payload (must fail closed). An agent waits for this before every edit. | hook |
| MCP server | Start plus handshake; `tools/list`; five read tools called on a running server | mcp-start, mcp-call |
| Scale | `purix index` at 500, 2,000 and 8,000 files, on a plain folder and in a real git repository; the slope between the two largest | scale |

**How it decides.** Each item is run once untimed (the cold number is recorded) and then five times; the **median** is judged against a budget in `scripts/speed-budgets.json`. The budgets are scaled by this machine's Node start-up time against the reference machine (25 ms), so a slow Windows runner is not failed for being slow. A wrong exit code is a failure, not a timing. A median inside budget but a slowest run over twice the budget is a warning. `--compare <file>` fails on a slow-down of more than 25% and 40 ms against a baseline saved with `--save-baseline` on the same machine.

**Budgets (milliseconds at the reference machine).**

| Class | Budget | Measured today | Why |
| --- | --- | --- | --- |
| version | 250 | about 75 | Process start only; the floor of everything else |
| help | 350 | about 80 | People type it when unsure; should feel instant |
| read | 500 | 90 to 175 | Well under Nielsen's 1 s limit |
| write | 700 | 95 to 185 | Light local writes |
| index-small | 1,500 | about 460 | The first command a new user runs |
| hook | 350 | about 120 | Runs before every agent edit |
| mcp-start | 1,500 | about 775 | Paid once per agent session |
| mcp-call | 300 | 1 to 5 | One read tool on a running server |
| scale | 10,000 for 8,000 files; slope at most 1.5; abort when one run passes 30,000 | about 160 (500 files) to 320 to 410 (8,000); slope 0.36 to 0.51 | Index should grow about in step with the project |

Budgets are about three to five times today's speed on purpose: they catch a real slow-down, not noise. Small slow-downs are the job of `--compare`. These numbers are the ones I propose; they need your approval (open decision 1).

**It cannot go stale silently.** The command list is found by running the built CLI, plus the registry of top-level names inside `cli.js`. A command that exists but is not classified in the script fails the run. A scenario that names a command or MCP tool that no longer exists fails the run. I proved both by deliberately breaking the script and seeing it fail. Hidden subcommands (`lang install`, `lang uninstall`) cannot be discovered from help text, so they are listed by hand and checked to exist.

**Resolved: `purix index` was quadratic and is not any more.** The 2026-11-04 run measured 300 files at 18 to 30 s (one project copy per file). In the current tree 300 files take about 160 ms and 8,000 files 320 to 410 ms. The old sizes (25, 100, 300) are now too small to show growth, because a fixed cost of about 150 ms dominates them, so the sizes were raised. The scale test also runs inside a real git repository, because `index` builds its file list differently there. It stops early when one run passes 30 s, so a return of the old bug fails in minutes, not hours.

**Not covered by the speed test.** Commands that need a model, the network, an account or a pending request are timed for `--help` only, each with its reason listed in the script. The time a real model takes is Step 7.

## 4. Step 2: Trust in the tests

A green suite only matters if its tests would go red on a wrong change and give the same answer every time.

| ID | Test | What it checks | How | Pass rule | Status |
| --- | --- | --- | --- | --- | --- |
| 2.1 | Repeat run | No test is flaky | `node scripts/repeat-run.mjs --runs 20 --quarantine docs/flaky-quarantine.json -- pnpm run test`; also the scheduled `repeat-run.yml`. Reads TAP and spec reporter output. | No test fails in any of 20 runs. Fix a failure in the same release or list it in the quarantine file with name, owner and date; after the date it fails the run again. | Built, updated (the quarantine file does not exist yet) |
| 2.2 | Change-based mutation testing | Tests fail when the code is wrong | Mutate only the lines a change touches, in the five coverage-gated folders first, and list the mutants no test caught. Run a JavaScript/TypeScript mutation tool (StrykerJS is the candidate) and a Python one (mutmut) | Report only for two releases. Then set a limit from the measured baseline, not a guess | To build (tool not yet tried here) |
| 2.3 | Changed-line coverage | Every changed line is run by a test | Extend the 90% gate in 1.16 to also report coverage of the lines in the pull request | No changed line left uncovered without a written reason | To build |
| 2.4 | Test size discipline | Fast tests stay fast and offline | Tag each test file small, medium or large; fail a small one that opens a socket or runs a child process | Counts per size reported each release | To build |
| 2.5 | Stand-in versus real tools | The suite's stand-in tools behave like the real ones | Run the verify tests once with the real TypeScript compiler, ESLint, pytest, ruff on Linux | Same results as the stand-ins | To build |

## 5. Step 3: Failure and attack

Things that must hold when something goes wrong or someone tries to get around Purix.

| ID | Test | What it checks | Status |
| --- | --- | --- | --- |
| 3.1 | Hook bypass | Hooks installed: a direct edit is blocked. Not installed: the edit lands and `check --strict` names it (1.20) | Built |
| 3.2 | Fail closed | An unreadable hook payload is blocked, never allowed (1.19, and timed in 1.11) | Built |
| 3.3 | Diff ingest replay | Real commits from real repositories: apply each file's diff to the parent and compare with the commit; shift every hunk header by 1, 3 and 10 lines (`scripts/replay-ingest-corpus.mts`, needs git clones) | Built, manual; make it a monthly job |
| 3.4 | Crash recovery | Kill the process in the middle of a write, then run `purix reconcile`: the manifest is intact or restored. The runner has no stage named for this; core has a recovery folder, so the first task is to list what it already covers | To build or confirm |
| 3.5 | Secret leak | After a run with a known fake secret set, search logs, audit chain, evidence bundle and diagnostics for it | To build |
| 3.6 | Parser fuzzing | Feed random and malformed input to the hook payload, diff and config parsers: the result must be a clean error or a block, never a crash or an allow | To build |
| 3.7 | Sandbox limits | Inside the sandbox: network off, no writes outside the copy, only allow-listed environment variables. Linux with bubblewrap only | Built (stand-in tools); real-tool run is 2.5 |
| 3.8 | Hostile environment | Read-only folder, full disk, locked file, killed server. Windows part is in 4.1 | Partly built |

## 6. Step 4: Other machines

| ID | Test | What it checks | How | Status |
| --- | --- | --- | --- | --- |
| 4.1 | Windows real machine | Launchers, CRLF, BOM, locked files, killed server, secret file permissions | `scripts/windows-test.ps1` (a stage of the runner on Windows). Run it again after today's changes; the last full Windows pass you told me about was 2026-10-07 | Built |
| 4.2 | Whole runner on Windows and macOS | Everything in Step 1 on each OS | The `os-smoke` job in `ci.yml` (windows-2022, windows-latest, macos-15, macos-latest). It runs the new speed stages too, with budgets scaled by machine speed | Built, updated by the runner change |
| 4.3 | Node matrix | Node 22.13.0 (the declared floor), 24 and latest | The `validate` job in `ci.yml` | Built |
| 4.4 | Make 4.2 required | Today it is allowed to fail. The CI file says to make it required after three green runs in a row on every image | Your decision when the three runs exist | Rule exists |
| 4.5 | Isolation matrix | Result with and without a sandbox tool; the result must say `isolation: none` when there is none | Built in parts; real-tool run on macOS and Windows still to do | Partly built |
| 4.6 | Speed on each OS | Record the Node start-up floor and the speed report per OS to see whether the scale factor is fair | `.test-logs/speed/speed-latest.json` from each CI job | New |

## 7. Step 5: Install like a user

| ID | Test | What it checks | How | Status |
| --- | --- | --- | --- | --- |
| 5.1 | Pack and clean install | Tarballs install in a folder with spaces and non-ASCII characters; version and help work; index, adopt, lock work; `check --strict` passes on a fresh checkout (files and lock, no store) and fails, naming the file, after an edit; versions, tarball contents and workflow files are right. With the store present, `check --strict` exits 1 on a file nothing has tested, so the fresh-checkout case is the one judged | `node scripts/release-check.mjs package` (stage 1.27) | Built, updated |
| 5.2 | Dependency audit detects | The audit really finds a known vulnerable package against live npm and pip | `node scripts/purix-04-run-all.mjs --only network --network` | Built |
| 5.3 | Release candidate from the registry | Publish an `rc` tag, install it in a clean folder on each OS from the real registry, run the first-run path | To run |  |
| 5.4 | First-run walk | A person who has never seen Purix follows the README exactly; time from install to first useful result; every point where they stop | To run |  |
| 5.5 | SBOM | A CycloneDX SBOM per package, every component in the lockfile | `node scripts/sbom-check.mjs` (part of 1.27) | Built; attaching it to the release is manual |
| 5.6 | Rollback rehearsal | Publish a deliberately bad rc, then deprecate it and move the tag back; confirm a new install gets the good one | To run |  |

## 8. Step 6: Real agents (real-time testing starts)

Config-level tests (1.21) do not show that an agent loads the file or calls a tool. `docs/client-runs.json` holds one row, OpenCode on Windows (2026-11-03), whose version is the placeholder "<the version text>"; it does not count until redone with the real version (the kit now refuses placeholders). Every other agent is "Not verified with the real client". An agent becomes *Supported* only when it has a passing row there.

**Tool:** `node scripts/real-agent-kit.mjs prepare <agent>`, run the agent as it tells you, `check <agent>`, then `record <agent> --version "..." --stderr-shown yes|no|unknown`. `check` now also needs the hook to have recorded a block for the governed edit (an unchanged file is not enough) and the ungoverned write to be named in the hook's stderr and in `purix check`. **First agents:** Claude Code, then Codex (the order in `BETA_SCOPE.md`).

| ID | Test | Pass rule |
| --- | --- | --- |
| 6.1 | The agent loads the hook and a direct edit of the governed file is blocked | Blocked, with the agent's own style of message |
| 6.2 | An edit of an ungoverned file is allowed | Allowed, no delay the person would notice |
| 6.3 | The agent calls `purix_status` and one change tool over MCP | Call arrives and answers. **Not provable from files today:** MCP read calls leave no event, so record it by hand |
| 6.4 | The agent asks for a tool install or an approval, and the person approves in a terminal | Request visible, approval recorded in the audit chain |
| 6.5 | The agent tries to write through a shell command | Result matches what `docs/HOOKS.md` says is caught and what it admits it misses |
| 6.6 | Hook delay measured inside the real agent | Same order of magnitude as the hook budget in 1.14. **Not provable from files today:** the payload log has timestamps, not durations |

The hook is plain code, so 6.1 and 6.2 need one clean run per agent. Anything the model decides (6.3 to 6.5) is run five times, and I report how many of the five passed, not whether one passed: a pass in one try says little about a model.

## 9. Step 7: Real model quality

The harness exists: `pnpm eval:l1` (`scripts/eval-l1.ts`). It refuses to start without `--budget-usd`, stops before a call that would pass the limit, records ids, tokens, cost, latency and outcomes, and never records prompts or replies.

| ID | Test | How | Pass rule |
| --- | --- | --- | --- |
| 7.1 | Harness check, no cost | `pnpm eval:l1 --dry --budget-usd 1` in CI (canned replies) | Runs and reports |
| 7.2 | Screening run | `pnpm eval:l1 --budget-usd 5 --cases 200 --trials 1` | A first rate per arm and tier; no pass rule yet |
| 7.3 | Deciding run | `pnpm eval:l1 --budget-usd 40 --trials 3 --out .eval/run1` | Pass rule set from 7.2 before this run, then not changed |
| 7.4 | Reliability | Report pass@k and pass^k side by side for the same cases | A large gap between them is itself a finding |
| 7.5 | Wrong-above-threshold rate | Among changes above the 0.75 confidence cutoff, how many were wrong. `BETA_SCOPE.md` says nothing measures this today | A measured number with its sample size, or the claim stays unmade |
| 7.6 | Failure reading | Read transcripts of failed cases and turn each real failure into a regression case | Each failure class has a case |
| 7.7 | End-to-end time | Time `change` and `modify` with a real model, split into model time and Purix time | To build as `speed-test.mjs --live` |

## 10. Step 8: Real people and value

| ID | Test | How | Pass rule |
| --- | --- | --- | --- |
| 8.1 | Value experiment | The same set of tasks done with and without Purix by the same developers, order randomized. Measure time to finish, tokens used, mistakes that reached review | A measured difference with the sample size, or the claim stays unmade (no measured proof exists today) |
| 8.2 | Developer QA pass | Repeat the 0.3.0 developer QA that concluded "not ready for external developers" against the release candidate | Every blocker from that report is closed or explained |
| 8.3 | Staged release | `rc` tag, then a small group, then `latest`. A canary is structured user acceptance, so decide in advance what would stop it | Stop rule written before the first user |
| 8.4 | Signals | Install success, command failures, slowest commands. Telemetry is off by default, so ask beta users to opt in or send `purix diagnostics` | Weekly review |
| 8.5 | After release | Follow `docs/compliance/post-market-monitoring.md` | Per that document |

## 11. Exit gates

| After | You may go on when |
| --- | --- |
| Step 1 | Every stage is PASS, or NOT CHECKED with a stated reason, and every KNOWN FAIL is written down with an owner |
| Step 2 | 20 repeat runs with no failure; the mutation report exists |
| Step 3 | 3.4, 3.5 and 3.6 exist and pass |
| Step 4 | Windows and macOS runs on file; 4.4 decided |
| Step 5 | An rc installed from the real registry on each OS; rollback rehearsed |
| Step 6 | Claude Code and Codex each have a passing row in `docs/client-runs.json` |
| Step 7 | A deciding run exists and its numbers are reported with their sample size |
| Step 8 | Value experiment reported; stop rule never triggered |

## 12. Decisions for you

1. **Approve the speed budgets** in section 3, including the new scale sizes and the 30 s abort.
2. **First-run contradiction (new).** After `purix index`, a hand edit of any indexed file makes plain `purix check` exit 1 ("Edits made outside Purix: purix-codebase-index changed outside Purix… across 0 governed components"), while the hook calls the same file "not governed". Decide whether the index component should count as drift. Step 5.4 will hit it.
3. **Mutation testing tool.** A short trial of StrykerJS and mutmut before committing to either.
4. **Make the Windows and macOS CI jobs required** once three runs in a row are green.
5. **Delete** `scripts/benchmark-cli-help.mjs` and the root `purix-mcp-smoke-test.mjs` (nothing references either).
6. **Redo the OpenCode row** in `docs/client-runs.json` with the real version, and refresh the `docs/CLIENT_SUPPORT.md` header (still Purix 0.3.0-beta.1).

The old decision about the index slowdown is closed: it is fixed.

## 13. What I did not verify

- Speed numbers come from one Linux machine with one CPU. No Windows or macOS numbers.
- Stages 1.19 (end to end), 1.20, 1.21, 1.28 and 1.29 were not run on 2026-11-12.
- The mutation tools have not been run on this code.
- I did not run `windows-test.ps1`, the real-agent steps (the kit was exercised against a simulated hook payload, not a real agent) or the real-model steps.
- Steps 5.3, 5.4, 5.6 and 6 to 8 are designs, not results.
- I did not check whether `publish.yml` runs the newer gates (env-docs, import cycles, claims, checks page, speed).

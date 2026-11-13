# Release 1 scope

Last updated 2026-11-08. This file says what Release 1 covers and what it does not. It replaces the 2026-08-05 beta scope note, which is not in this snapshot of the repository. One sentence of that note is kept elsewhere in the project's records: "Purix beta ships with TypeScript and Python support. Rust, Go, and Ruby provider code has been removed from this release entirely — not deferred, removed."

## What Release 1 is

Release 1 is published as **0.4.0-beta.x** under the npm `beta` tag. What a user can learn about data handling is in [PRIVACY.md](./PRIVACY.md); how to report a vulnerability, and the limits that are known and documented, are in [SECURITY.md](./SECURITY.md).

A command-line tool and an MCP server that run on your own machine. Apache 2.0. Everything in this repository runs without a Purix account. Sign-in, billing, team features and the hosted API are not part of Release 1.

In this snapshot the client still enforces a limit of 25 tracked components on the free tier, and there is no way to pay to lift it yet. Treat that limit as a known rough edge until it is changed.

## Languages

- **TypeScript and Python.** JavaScript files (`.js`, `.jsx`, `.mjs`, `.cjs`) are claimed by the TypeScript provider. This file makes no claim beyond that mapping; JavaScript-only projects have not been tested separately.
- **Rust, Go and Ruby** were removed, not hidden. The records give four reasons for choosing Python and not these three: whether the provider is gated as public or internal in `registry.ts`, the precedent in the tier configuration, a toolchain-isolation fix that Python and Go/Ruby went through together and Rust did not, and comparable test-suite depth.
- **Any other language is not supported.** A file in another language is not checked by Purix. Purix says so: "Unsupported language, not checked". A change made only of such files is stopped and not applied. In a mixed change those files are listed as not checked and the run is not shown as fully verified. Read a clean result as covering TypeScript, JavaScript and Python files only.

### Adding a language back

1. Add a manifest in `packages/core/src/language/manifests/` (file extensions, tier, capabilities).
2. Write a provider in `packages/core/src/language/providers/` and add it to the internal list in `registry.ts`. That list is empty today and is switched on with `PURIX_INTERNAL_LANGUAGES=true`, so a new language can be tried without shipping it.
3. Add its id to the `languages` list in `packages/core/src/language/conformance/run.ts` and add fixtures under `conformance/fixtures/<id>/`. The conformance suite must pass before the language is moved to the public list.

## Platforms and agents

- Linux is where the test suite and CI run. Windows and macOS jobs exist in CI but are set not to block releases, and the only real-agent run on file is OpenCode on Windows, and none is on file for macOS. Treat both as experimental.
- One real coding agent has been run with Purix connected: OpenCode on Windows, one run (`docs/client-runs.json`). `docs/CLIENT_SUPPORT.md` lists every other agent as "Not verified with the real client". Claude Code and Codex are the next planned runs.
- Cursor is experimental for a further reason: the sources for its hook format are third-party, and there are reports of its hooks not firing on Windows and in its command-line tool (`docs/HOOKS.md`).

## How to read a result

- **Results are reported, not settled.** A result is what Purix's checks reported on one machine. Until real agents, Windows and macOS have been run, Purix does not call any of its guarantees settled.
- **Shell screening is a tripwire, not prevention.** The hook's check of shell commands catches common ways of writing to a governed file and misses others. `docs/HOOKS.md` lists what it misses.
- **Isolation is described for TypeScript projects on Linux with bubblewrap.** It is not checked on macOS or on Python projects. The test suite uses stand-in tools, and a run with the real tools on each system is still to do. The later re-check of dependents runs in a throwaway copy of your project, not in your real folder. The TypeScript compiler and ESLint run in the same sandbox as the tests where one exists (project read-only, network off, only an allow-listed set of environment variables, a scratch HOME), and `PURIX_STRICT_ISOLATION=1` makes any step refuse to run without one. A project's own compiler or linter is still code the project chose: the sandbox contains it, it does not vet it. Where there is no sandbox tool (Windows, or a container that blocks it) these steps run unisolated and the result says `isolation: none` for the compiler; the style check's result does not carry an isolation level. Replayed on 2026-11-08 with no sandbox tool present: a project's own planted `node_modules/.bin/eslint` still runs as you, with no secrets in its environment (allow-listed variables, scratch HOME) but able to write files and reach the network, and with `PURIX_STRICT_ISOLATION=1` it does not run. A project whose tsconfig makes tsc write a build-info file (incremental or composite) gets "Could not check", not a failure of its code.
- **No safety rate is stated for the 0.75 auto-commit threshold.** It is a cutoff on the model's own stated confidence. Nothing in this repository measures how often a change above it is wrong.
- **A passing test run is not proof that the code is correct.**

## Not in Release 1

- The dependents check covers only components Purix created. Components added with `adopt` or `index` have no recorded dependency edges, so the check finds no dependents for them.
- Dependency checks inside verification: a change that adds a dependency is not scanned for known vulnerabilities, and nothing checks that the new package exists. `purix audit` runs the vulnerability scan on request. It has been measured returning nothing for pnpm projects that have known advisories, so do not read "none found" on a pnpm project as clean.
- Retrieval over the component index, mutation testing, changed-line coverage, managed policy files per agent, Java and C#, binary tools in the tools catalog, log retention and replay.
- The hosted API, Team and Enterprise tiers.

## What is not claimed anywhere in this repository

The compliance documents in `docs/compliance/` describe what the code does today and list known gaps. They are not a certification, and they do not claim conformity with ISO/IEC 42001 or the EU AI Act.

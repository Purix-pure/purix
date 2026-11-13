# `purix check`

The one canonical check. A developer, a git pre-commit hook, CI and an agent hook adapter all call the same command and
get the same answer.

```
purix check [--strict] [--json]
```

It answers one question, with no model and no network: **does what is on disk still match what Purix governed, and is
the evidence intact?**

## What it checks

| Section | Fails when |
|---|---|
| Purix state | The local store is damaged (it is never repaired or rebuilt). Skipped when there is no store or no registered component: nothing is governed, so nothing was checked. |
| Audit chain | A record was altered, removed or reordered (same rule as `purix audit-log verify`). An empty chain is skipped, not passed. |
| Interrupted operations | An operation started and never finished. |
| Edits made outside Purix | A governed file's content differs from the hash recorded at the last sync, is missing, or its manifest path leaves the project. A component that was never synced is skipped (edits to it cannot be detected). |
| Verification status | The last verification failed. A component that is `pending` (no test has run) or whose passing run left files untested is skipped, with the words "not tested". |
| Installed tools match their lock | An installed tool is missing, or the files next to it differ from what was installed, or the lock file is unreadable. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Nothing wrong found. Without `--strict`, skipped items still exit 0 and are printed with a warning mark. |
| 1 | The check found a problem. With `--strict`, a skipped item also exits 1. |
| 2 | The check could not run at all (a crash, a bad option). A caller that must fail closed treats 2 like 1. |

Use `--strict` in CI and in any hook that must not let unverified work through (see "CI: the committed lock" below; a plain CI checkout has no Purix state at all). Without it, a folder with no Purix state
passes with a warning, which is right for a developer typing the command and wrong for a required check.

## Guarantees (each one has a test)

- **Read-only.** The store file stays byte-identical. It never creates, repairs, migrates, locks or appends to anything.
  The one trace it can leave is SQLite's own empty `-wal` and `-shm` files, which SQLite creates whenever a WAL-mode
  database is opened, even read-only.
- **Deterministic.** The same disk gives the same report.
- **Honest.** It uses the single result vocabulary. A check that did not run is `skipped`, never `pass`.

## CI: the committed lock (`purix.lock.json`)

Purix's local store lives in your working copy (`.purix/`) or, in a git repository, in `.git/purix-state/`. A CI checkout
is a fresh clone and has neither, so `purix check --strict` there would find nothing to compare against. The fix is the
one package managers use for lockfiles: a small committed file, verified in CI.

- `purix lock` writes `purix.lock.json`: for each governed component, its version and one SHA-256 per governed file
  (line endings normalised, so a Windows checkout with autocrlf is not read as an edit). No file contents.
- Commit it. Once it exists, every landed change (create, modify, ingest, adopt, delete, accept-drift) rewrites it, so
  it is committed together with the change.
- On a checkout with no local store, `purix check` verifies the governed files against the lock: a changed or missing
  file fails, a damaged lock fails. Where a store exists, the check also reports a lock that was not refreshed.
- Template for your own CI: `docs/ci/purix-check.yml`. This repository's own `ci.yml` and `publish.yml` run
  `scripts/ci-lock-flow.mjs`, which does adopt, lock, fresh checkout, strict check, direct edit. `publish.yml` runs it on Linux only; `ci.yml` also runs it on Windows and macOS, in a job that is
  allowed to fail for now, so treat those two platforms as unconfirmed.

What the lock check does **not** do: it does not check the audit chain or verification status (they are in the local
store and are not part of a checkout; the summary says so), and it is not tamper-proof. Someone who edits a governed
file and `purix.lock.json` in the same commit passes it. Make the job a required status check and require review on
`purix.lock.json` (CODEOWNERS) so that edit is seen by a person.

The audit chain now records every landed change (`component_change`: kind, component, version, sync hash, operation,
source; never file contents), not only tool installs and drift events.

## `--json`

Schema version 1. `outcome` is the worst result (`fail` > `error` > `skipped` > `pass`). Each section has an `id`, a
`title`, an `outcome` and `items` (`outcome`, `subject`, `message`). `exitCode` is the code the command will exit with.

## What it does not do

It does not decide whether a change is correct, and it does not approve anything. It reports whether governed files and
the evidence still match what Purix recorded. It cannot see an edit to a file Purix never registered. Agent hook adapters (`purix hooks install`, see HOOKS.md) are a separate piece: they block direct edits to governed files
before they happen, with their own limits. The CI path is the committed lock above.

## Known limit

On a read-only filesystem, opening a WAL-mode database can fail. The check then reports the store as unreadable rather
than passing. That is the safe direction, but it is untested on real read-only mounts.

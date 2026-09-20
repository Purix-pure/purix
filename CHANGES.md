# Purix Fix Changeset

Applies fixes for the duplication and gap findings from the earlier audit
(`purix-audit.md`). Every file below was individually re-verified with
`tsc --noEmit` after editing (baseline: the same 14 pre-existing errors,
confined to one unrelated test file, throughout) and, where applicable,
re-scanned with `jscpd` to confirm the flagged duplication is gone.

Only files that actually changed are included, in the same relative paths
as the original `packages.zip`. One file is deleted rather than modified —
see `DELETED_FILES.txt`.

## Fixed

**2.1 / 2.2 — `lifecycle.ts` / `server.ts` pipeline duplication**
Extracted `resolveVerification()` (new: `core/src/recovery/resolve_verification.ts`) —
the verify → self-heal → escalate resolution logic previously duplicated
between the CLI's `modify` and `ingest` commands. Both now call it.
While doing this, found and removed ~31 unused destructured imports in
`ingest`'s runtime loader and one in `modify`'s, and split `ingest` onto
its own lightweight `loadIngestRuntime()` (following the same pattern
`loadCreateRuntime`/`loadDeleteRuntime` already established), since it
only needed ~10 of the 26 modules the shared loader pulled in.
A further, smaller duplication remains between `modify` and `ingest`'s
commit + migration-cascade blocks — not yet extracted (see "Not done"
below).

**2.4 — `test_integrity.ts` / `python_test_integrity.ts`**
Extracted a shared generic `diffTestProfiles()`. `python_test_integrity.ts`
now imports `TestIntegrityFinding`/`TestIntegrityResult` instead of
redeclaring them, and its embedded Python AST visitor now tracks
assertion **targets** (via `ast.unparse`, safe on this project's Python
3.10+ floor), not just a count — closing the gap where it couldn't
detect an assertion being silently swapped for a different one.

**2.5 / 3.2 — `server.ts` gated-action boilerplate + untyped args**
Extracted `requireGatedApproval()`, consolidating the budget-check-then-
confirm preamble repeated at all 7 gated MCP tools. Verified each tool's
distinct rejection wording (verb + CLI-equivalent command) was preserved
exactly — these were not identical text, only identical *shape*, so
they're still parameters, not flattened into one generic message.

**2.6 — `budget.ts`**
Extracted `applyCostDelta()`, removing the duplicated 29-line cost-
accounting block between `recordUsage`/`recordProviderUsage`.

**2.7 / 3.1 — `manifest/indexer.ts`**
Extracted `makeRecord()` for the repeated 8-field record literal, and
removed the dead Rust/Go/Ruby extraction branches in the same pass.

**2.8 — `escalate.ts` / `heal.ts`**
Extracted `applyEditsAndCheckOscillation()` into `oscillation_guard.ts`
(where the guard class itself documents an earlier, similar
consolidation). jscpd confirms 0 remaining clones between the two files.

**2.9 — `manifest/store.ts`**
Extracted `upsertManifestRow()` so the header comment's transactional-
safety argument (both writers must run the *same* insert inside one
transaction) is enforced by structure, not convention.

**3.1 — stale Rust/Go/Ruby references**
Fixed in `indexer.ts` (above), `platform/toolchain_tmp.ts` (narrowed
`ToolchainLang` to `"python"`), `entrypoints/scaffold.ts` (removed dead
extension mappings), and `cli/commands/lang.ts` (trimmed the displayed
language list). Found a fourth instance while sweeping for dead code:
`language/conformance/provenance.ts` was an entirely orphaned module
(single importer, which didn't use it) still listing all three removed
languages — deleted rather than fixed in place, since nothing used it.

**3.3 — line endings**
Added `.gitattributes` (`* text=auto eol=lf`) and `.editorconfig` at the
repo root. Normalized 49 non-test source files from CRLF to LF (left
`.test.ts` files untouched to limit blast radius). Files that were
already LF are not included here even if they sit next to normalized
ones.

**General dead-code sweep**
Per request, also removed dead imports found while working through the
above, unrelated to their host finding: `SecretFinding` in
`gates/security_gate.ts`, `MigrationRecord` in `state/migration.ts`,
`mkdirSync` in `language/providers/python.pack.ts`, and
`providerKitHooks`/`runIsolatedOrNotInstalled` in
`language/providers/typescript.ts`. Each was verified with grep to have
zero real usages (beyond its own import line) before removal; one
candidate (`cli/commands/dev.ts`) was checked and correctly left alone —
the names appeared only inside a generated-code template string, not as
an actual unused import.

## Not done (still open)

- **2.3** — idiom-check logic still duplicated between
  `cli/commands/observability.ts` and `mcp-server/server.ts`.
- **Residual `lifecycle.ts` duplication** — the commit + migration-
  cascade block that follows the now-extracted verify/heal/escalate step
  is still duplicated between `modify` and `ingest` (jscpd: down from 15
  internal clones to 11, not yet 0). Left alone rather than forcing a
  rushed abstraction over logic this safety-critical late in this pass.
- A full manual line-by-line audit of `cli.ts` and `store.ts` beyond what
  the original audit already covered.
- Test coverage additions for `escalate.ts`/`heal.ts`/
  `python_test_integrity.ts` (original finding 3.4) — no test files were
  added in this pass, only production code fixes.

## Verification method

No `node_modules` were available in this environment, so `tsc --noEmit`
naturally reports `@types/node`/module-resolution noise unrelated to any
edit. Every file change was checked two ways: (1) the standard
`tsc --noEmit -p tsconfig.json` run per package, confirmed to stay at the
exact same baseline error count/location as an unmodified checkout, and
(2) for files with real edits, a second pass with `types: []` to strip
the noisy `@types/node` requirement and grep for errors specific to the
changed file, confirming zero *new* errors beyond the environmental
noise. `jscpd` (the same tool used for the original audit) was re-run
after each duplication fix to confirm the specific clone was resolved,
and once more across the full tree at the end (36 clones / 2.10%
duplicated lines → 24 clones / 1.16%).

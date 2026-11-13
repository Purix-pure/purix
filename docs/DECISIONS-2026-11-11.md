# Decisions taken on evidence, 2026-11-11

The founder asked the session to decide, on research, what the plan had left to him, because he will run the release on his own machine afterwards.
Each decision names its evidence and how to reverse it. None of these was re-read by a second person.

## D-j: ratify C1 (secret shapes now block a write, not only scrub). Decision: ratify.
- Industry practice: GitHub blocks a push that contains a detected secret before it lands and offers a logged bypass with a stated reason
  (GitHub Docs, "About working with push protection"). Purix's override path with an audit entry plays the bypass role.
- Measured here: the secret scan over the Purix repository (858 files, a repository the founder trusts). Outside tests, fixtures and docs it flagged 4 lines.
  Two were AWS's published example key inside a test snippet. Two were model ids (`accounts/fireworks/models/llama-v3p1-8b-instruct`) flagged by the
  old high-entropy rule, not by C1: a real false block. Fixed in `security/secrets.ts` (identifier-shaped strings are exempt; mixed-case and
  separator-free tokens still block; `security/secrets_identifier.test.ts`). After the fix: 0 false blocks outside test fixtures on this repository.
- Limits that stay in the release note: split-across-variables, base64 and `join()` are still missed; one repository is one sample; gitleaks was not run.
- Reverse: move a pattern back to `SCRUB_ONLY_PATTERNS` (one list entry).

## D-o: put the import-cycle check in the runner, release check and CI. Decision: yes, done.
- CI runs `scripts/purix-04-run-all.mjs`, so the new stage `import-cycle-check` reaches CI through it; `release-check.mjs` has the same step.
- The check ran clean here (247 files, 0 cycles). The plan wanted one real-machine run first; the check is plain Node, so this Linux run is taken as enough.

## D-h: which `server.json` is the registry listing. Decision: the root one.
- The registry matches the listed npm package's `mcpName` to the listing name and a client must be able to start the package. `@purix/cli`
  has a `bin` and the `mcp-serve` command; `@purix/mcp-server` has no `bin`. Nothing referenced `packages/mcp-server/server.json`; it is deleted.
- Reverse: restore the file from history. `mcpName` stays in both `package.json` files.

## Checked and left alone
- CI uses `pnpm/setup@5d160c5...` (# v1). I suspected a wrong action name (the well-known one is `pnpm/action-setup`). `git ls-remote` shows `pnpm/setup` exists and that
  commit is its `v1.0.0` tag. No change.

# Purix handoff, 2026-11-21: credentials, messages, and the merge

Base: `packages.zip` (version 0.4.0-beta.4). Everything below was checked against that tree.
Deliverable: `purix-merged-changes.zip` (changed files only, same paths; unzip over the packages.zip tree) and `purix-merged-changes.patch` (the same as a diff against it).

## 1. The problems we set out to fix

Quoted or read from the code (not run unless said):

1. **The key store followed the folder.** `secrets_manager.ts` built the store from `process.cwd()`. A key saved in one folder was invisible from another, including a subfolder of the same project.
2. **The stored key beat the environment.** `resolveKey` was `getSecret(name) ?? dataDrivenEnv(name)`. An old stored key silently beat a good environment key, and the provider only said "API key not valid".
3. **The master key sat beside the ciphertext.** Anyone who can read the folder can decrypt it.
4. **The webhook secret was never read.** The sender looked for `purix_webhook_secret`, a name `purix secret set` refuses.
5. **Messages that blamed the wrong cause.** A question nobody could answer (an agent's shell, a pipe, CI) was reported as "Bootstrap declined" or "Cancelled", as if a person had said no. `purix check` described a deleted file as "changed outside Purix" with no next step, repeated one adopt sentence per file, and used internal words ("component").
6. **Unknown command `doctor`** gave no hint that `purix hooks doctor` exists.
7. **An agent could read the stored key**, not only write it: nothing stopped `cat` of the master-key file or a keyring lookup.

From the user-test run (opencode agent): the Phase 5 "drift" failures were a test-setup problem (two `security_gate` files had been deleted from the test folder), the agent's "Purix is not CLI-friendly" conclusion was mostly the approval prompt working as designed, and the run stopped at Phase 3 of 13, so Phases 4 to 13 are untested.

## 2. The three change sets

| Set | What it is | Core idea |
|---|---|---|
| **A** `purix-key-store-changes.zip` (37 files) | Full user-level credential store | Separate `user_secrets.ts` (OS keyring first, encrypted-file fallback with its own file names), `secret_migration.ts`, `user_dir.ts`; hook rule `secret-read` covering file tools and shell; approver and no-input messages |
| **B** `purix-fixes-2026-11-21.zip` (31 files) | Same feature built a second way | Folded the user store into `secrets_manager.ts`; `keyring_backend.ts`; old store searched in parent folders; non-interactive `migrate`; a filename tripwire in the hook; drift message in `lifecycle.ts`; `USER-TEST-PROMPT.md`; end-to-end test |
| **C** my `purix-message-fixes.zip` (7 files) | Plain-language `purix check` | `next` step on every drift failure, shared next step printed once, no "component" wording, `doctor` hint |

A and B each passed their own full test suites alone (core: A 2,979 passing, B 2,944, no failures). A and B collided on 19 files; C overlapped with neither.

## 3. How the overlaps were resolved (no duplication)

Base: **A**, for these reasons found in the code:
- It reads the keyring value back after writing, and refuses the keyring on Linux without a desktop session (I found neither check in B's `keyring_backend.ts`).
- `purix secret migrate` needs a person at a terminal, asks before copying and before removing, and never overwrites a different key (B's runs without a terminal).
- Its hook rule covers an agent's file-reading tools, wildcards and keyring readers (B covered only shell text by file name).
- It has the wider tests (user store, migration, hooks, no-input message, webhook name).

Ported from B (things A lacked):
- Walk-up search for the old per-folder store, from the folder it was saved in and every folder below it (nearest wins). Lives in `secrets_manager.ts` (`findFolderStoreDir`, `legacyStoreFile`); lookup, status, migrate, remove, the hook's protected paths and the messages all use it.
- A hook rule that denies a command naming a credential file by file name in **any** folder (`secrets.master.key`, `user-secrets.enc.json`, ...).
- "Real keyring held back" in `auto` mode when `NODE_ENV=test`, `CI` is set, or `PURIX_USER_DIR` is set, so a test cannot write into a developer's Credential Manager or Keychain.
- The drift wording in `lifecycle.ts`, `docs/USER-TEST-PROMPT.md` (Phase 14 rewritten for the merged design), the end-to-end test (adapted), `protected_user_dir.test.ts`, the `migrate` entry in `cli.integration.test.ts`.

Dropped as duplicates of A: B's `keyring_backend.ts` and its tests, B's rewrite of `secrets_manager.ts`, B's `PURIX_KEYRING` variable (A's `PURIX_SECRET_BACKEND` stays), B's non-interactive `migrate`, B's own copies of the providers, credential-guard, confirm, auth and notify changes, and B's `secrets_user_store.test.ts` (every scenario was already in A's tests except the walk-up, now tested in `secrets_manager_walkup.test.ts`).

A defect fixed during the merge (present in A alone, not in B): the repo's single-point guard failed (`R1`: core wrote to stderr; `R3`: `.purix` text in comments). Core now queues credential notices and hands them to a sink that the CLI installs (`setCredentialNoticeSink`); the CLI prints them to stderr, except for `hook ...` commands, whose stderr an agent reads as the reason for a block. No baseline was raised.

## 4. What the merged tree does

**Credentials**
- One store per person, in the OS keyring when it works, otherwise an encrypted file in the user folder (`~/.purix`, or `PURIX_USER_DIR`), with a notice saying which. `PURIX_SECRET_BACKEND` = `auto` (default), `file` or `keyring`.
- Lookup order: environment (including `.env`), then the user-level store, then an old per-folder store (this folder or one above it), then a clear "not found" naming all three places. This reverses the old order.
- `purix secret set | rotate | remove | status | migrate`; one rule set (`credential_guard.ts`); `provider status` and `secret status` say where the key came from and warn when another place holds a different value.
- The webhook secret is read as `PURIX_WEBHOOK_SECRET` (the old lowercase name is still tried).
- Hooks (`secret-read`): refuse an agent's shell command or file tool that names a credential file, reads the keyring, or writes into the user-level Purix folder; `secret set|rotate|remove|migrate` stay person-only.

**Messages**
- "No input available" and the first-run approver message say a person must answer in a terminal, instead of reporting a refusal.
- `purix check`: every drift failure ends with what to do; a step shared by several files is printed once; agent-written files say `written by an agent (opencode); not governed by Purix, so Purix did not verify it`; `--json` items gain an optional `next`.
- `purix modify` and related commands say when files are missing from disk instead of claiming an edit.
- `purix doctor` suggests `purix hooks doctor`.

## 5. Evidence

Run on the merged tree (Node 22.23.5 in this container):
- Core: 4,057 test results passing, 0 failing. CLI: 343 tests, all passing (the one failure in the first run was only the missing `dist/cli.js`; after a build it passes). Typecheck clean for core, mcp-server and cli.
- Guards passing: core-boundary, core-exports (108 subpaths), env-docs (28 variables), import cycles (0), claims, checks-page, single-point.
- ESLint on the changed source files: no problems reported.
- By hand with the built CLI: `secret set` with `PURIX_USER_DIR` prints the keyring notice once and stores the key; `provider status` from a subfolder finds it; `purix doctor` shows the hint.
- After the last wording edits I re-ran only the affected tests (e2e, first-run, integration, migration), not the full suites.

## 6. Not verified, and limits (stated, not hidden)

- **The real OS keyring was never exercised.** Tests use a fake keyring; this container has no D-Bus or Secret Service. Needs a run on Windows (Credential Manager), macOS and a Linux desktop. The package `@napi-rs/keyring` 2.1.2 installs here; its behaviour on Node 26.5 and Windows is untested.
- Everything ran on Node 22, not your Node 26.5.
- **A keyring does not stop another program running as you, an agent included.** The hook rules are a text check on the command, not a wall: a path built at run time or a script run later is missed. Claude Code's built-in `Read` tool is not in the registered hook matcher, so it is not covered.
- **Walk-up widens one thing**: an old per-folder store in any folder above where you run Purix can supply a key. Before, only the exact folder. A cloned repository that commits its own `.purix/secrets.enc.json` and master key would be read the same way it was before; the notice names the file used, so it is visible.
- The master key beside the encrypted file (the fallback) is the same weakness as before; it is announced, not removed.
- The user-test run reached Phase 3 of 13; the new `docs/USER-TEST-PROMPT.md` Phase 14 is untested.
- The two `SECURITY.md` copies differ at line 53; they also differ in packages.zip, so I left that alone.

## 7. Open decisions for you

1. Should `purix migration accept-drift` be human-only like `secret set`? The new `purix check` next step tells people to run it "yourself in a terminal"; the code asks for a confirmation, but I did not read that path closely.
2. Do you want top-level `list`, `show` and `find` commands? The test script mentions them; they do not exist (only under `migration`, `lang`, `tool`, `provider`). Otherwise fix the script.
3. Before the next test run, restore the two deleted `security_gate` files in the test folder (`git restore packages/core/src/gates/`), so `purix check` is not reporting drift unrelated to the test.
4. A standalone MCP server process (not started through `purix mcp-serve`) queues credential notices silently; only the CLI prints them.

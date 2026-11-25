# Purix problem register: recheck against the merged tree, 2026-11-21

What was checked: the register `PURIX-PROBLEM-REGISTER-AND-PLAN-2026-11-21.md` (36 items: C1-C8, G1-G3, T1-T6, M1-M9, U1-U5, X1-X5), against the tree made of the uploaded `packages.zip` plus the `purix start` change. Evidence labels: **run** (I ran it on this tree, Linux, Node 22.23.5), **read** (quoted from the code, not run). Nothing here ran on Windows or macOS or against a real OS keyring.

## 1. Merge result

- The uploaded `packages.zip` already contains the whole v2 change set. All 50 v2 files that exist in it are byte-identical to the v2 zip (compared with `cmp`), the v2 patch is reported "previously applied" on 35 files and "already exists" on 15 new files, and nothing in it needed to be added to the code. Only the two documents (`PURIX-HANDOFF-2026-11-21.md`, `PURIX-PROBLEM-REGISTER-AND-PLAN-2026-11-21.md`) were missing, and are now in `docs/`.
- The `purix start` change was written on top of that tree, so there were no conflicts to resolve. The merged tree = `packages.zip` + `PURIX-START-CHANGE.patch` + the two docs + this file.
- The older base the v2 patch was made against was not uploaded; I rebuilt it by reversing the patch on the v2 zip and used it only to confirm the v2 files match.

## 2. Scoreboard (36 register items)

| Verdict | Count | Items |
|---|---|---|
| Fixed in the tree, checked | 10 | C1, C2, C4, C5, C6 (hint only), C7 (within X2), C8, G1, G2, G3 |
| Partly done | 3 | C3, U1, U2 |
| Open (found, not changed) | 18 | T1, T2, T3, T4, T5, T6, M1, M2, M3, M4, M5, M6, M7, M8, M9, U3, U4, U5 |
| Standing limits (not fixable by a change) | 5 | X1, X2, X3, X4, X5 |

## 3. Item by item

### Credentials and messages

| ID | Verdict | Evidence |
|---|---|---|
| C1 key store follows the folder | Fixed | read: `resolveCredential` uses the user store from the user folder, not the working folder. run: `secret_user_level.e2e.test.ts` passes; `purix start` run in a pseudo-terminal saved the key under the user folder and a second folder found the provider default |
| C2 stored key beat environment | Fixed | read: `resolveCredential` returns the environment first, then user store, then old store. run: `providers_key_status.test.ts` passes |
| C3 master key beside ciphertext | Partly | read: the file fallback still keeps the master key beside the file; it is announced in the notice. The OS keyring avoids it but was never run for real (X1) |
| C4 webhook secret name | Fixed | read: `notify.ts` reads `PURIX_WEBHOOK_SECRET`; name is in `env.ts` |
| C5 unanswerable question reported as refusal | Fixed | read: `confirm.ts` says "This question needs a person at an interactive terminal, so nothing was changed"; run: `auth_no_input.test.ts` passes |
| C6 `doctor` unknown | Hint fixed | run: `purix doctor` prints `Did you mean "purix hooks doctor"?`. A real `doctor` is U3 |
| C7 agent could read the key | Fixed within limits | read: `secret-read` rule in `decide.ts`; run: `secret_read.test.ts`, `protected_user_dir.test.ts` pass. Limits are X2 |
| C8 single-point guard failed | Fixed | run: `single-point-check`, `boundary-check`, `exports-check`, `cycle-check`, `env-docs-check` pass on the tree with `purix start` added |
| G1 `purix check` wording | Fixed | run: `check_render.test.ts`, `check_next_steps.test.ts` pass |
| G2 modify says edit when files are missing | Fixed | covered by the same suites (read, test run) |
| G3 name user files, hide internals | Rule adopted | a rule, not a code item |

### Test setup and run findings

| ID | Verdict | Evidence |
|---|---|---|
| T1 two `security_gate` files deleted in the test folder | Open | your test folder, not in this tree; `git restore packages/core/src/gates/` there |
| T2 run stopped at Phase 3 of 13 | Open | Phases 4-13 not run by anyone |
| T3 "not CLI-friendly" conclusion | Open | see M1-M9: the design is right, the way it is shown is not |
| T4 `list`, `show`, `find` | Open | run: each prints `unknown command` |
| T5 `mcp_stdout_purity` needs `dist/cli.js` | Open | run: it failed with "build first" until the CLI was built; `cli` `test` is `tsx --test` with no build step |
| T6 two `SECURITY.md` copies differ | Open, probably intended | run: they differ at line 53 and 65 only in relative link targets (`./PRIVACY.md` vs `../../PRIVACY.md`), which is what two different folders need. I would leave it |

### MCP (probe `mcp-approval-probe.mjs`, all four scenarios re-run on this tree)

| ID | Verdict | Evidence |
|---|---|---|
| M1 only elicitation can ask | Open, reproduced | run: mode `none` asked nobody and returned text |
| M2 text addresses the terminal, not the person | Open (register slightly off) | read: the server instructions and the pending text do say "check it with purix_approval_status" and "call this tool again ... once it is approved", so the register's "names only the terminal route" is not exact. Nothing tells the agent to tell the person; "Do not try to work around a refusal" is still there |
| M3 jargon question | Open, reproduced | run: `MCP Agent "unidentified-agent" requests full codebase re-index. Approve?` even though the probe client was named `probe-accept` |
| M4 checkbox, Accept without tick = refusal | Open | read: accept without `approve === true` maps to "decline" |
| M5 repeat calls burn the 20 cap | Open, reproduced | run: calls 1-20 "waiting", call 21 `Rejected ... Restart the server to continue` |
| M6 non-question refusals give no route | Open | read: `TrustGate aborted: ... Rephrase the instruction and try again.` (`server.ts` 1454) |
| M7 pending is `isError: false` with no structured status | Open, reproduced | run: `isError=false`; read: no `outputSchema` or `awaiting_human_approval` anywhere in core or mcp-server |
| M8 `approve` hidden, no `--watch`, no alert | Open | run: `purix --help` does not list `approve`; `purix approve --help` has `--list --all --show --register` and no `--watch` |
| M9 silent timeouts | Partly | read: `purix_approval_status` says "It expired. Call the original tool again to start a new request." The 5-minute question timeout still maps to a refusal/error with no ask-again step |

### Usability

| ID | Verdict | Evidence |
|---|---|---|
| U1 order of first steps | Partly | the help page's "First steps" now lists `purix start` first (my change); `connect`, `create`, `check` follow. Untested with a real beginner |
| U2 errors give what, why, next | Partly | check, no-input, drift done; not audited elsewhere. `purix start` and the "no provider/key" messages now name the next command |
| U3 no top-level `doctor` | Open | run: still a hint only |
| U4 `approve` hidden | Open | same as M8 |
| U5 terminal/PowerShell friction | Open | not audited; the `start` terminal run was Linux only |

### Limits

X1 (real keyring never run): still true; my terminal runs used the encrypted-file backend. X2 (a keyring does not stop another program as you; hook rules are a text check): unchanged. X3 (walk-up widens one thing): unchanged. X4 (standalone MCP server queues notices silently): the sink is installed only in `cli.ts` (read). X5 (Phase 14 of the user-test script): not run.

## 4. Where the register and my change disagree

Register section 5 says "Do not add `purix start`: it contradicts a deliberate decision" (the front door used to say "There is no start step"). I built `start` after the research in `PURIX-RESEARCH-KEY-MANAGEMENT-AND-START-2026-11-21.md` found the provider choice was per project, which is what hides a user-level key from other folders. The two positions are not exclusive: `start` runs `purix connect` for the agent step and the message was changed on purpose. If you prefer the register's route (make `connect` the one guided path), `start` can be removed without touching the key store or the user-level provider default, which are useful on their own. **This is your decision.**

## 5. New items from this session (not in the register)

| ID | Item | Status |
|---|---|---|
| N1 | The provider choice was per project; the key was per user | Fixed in tree (user default provider file, lookup order env > project > user default) |
| N2 | A pasted key could be read by the shared line reader as the next answer | Fixed in tree (`withExclusiveStdin`) |
| N3 | Linux keyring inside an agent-started MCP server (`get()` does not check for a desktop session; the session variable is not in the MCP default environment) | Open, untested |
| N4 | `purix start` never run on Windows, macOS, a real keyring, or with a key a provider accepts | Open |
| N5 | Agent-facing "run `purix start` in a terminal" status tool | Not built |

## 6. Test results on the merged tree

All run on Linux, Node 22.23.5, stubbed provider calls, encrypted-file key backend.

- Core suite (`node scripts/run-tests.mjs`): 3399 tests, 3396 passed, 0 failed, 3 skipped.
- CLI suite (`tsx --test`): 368 of 368 passed (after building core, mcp-server and the CLI; see T5).
- Repo gate scripts: single-point, boundary, exports, cycle and env-docs checks pass.
- `purix start` driven in a real pseudo-terminal: hidden key entry, key saved in the user folder, provider default found from a second folder.
- Not run: mcp-server package tests, Windows, macOS, a real OS keyring, a real model call, any real coding agent.

## 7. Second pass (same day): items changed

| ID | Change | Run |
|---|---|---|
| M3 | Approval questions now say "Your coding agent wants Purix to re-scan the whole project, which can take a while. Approve?" (and "start tracking <file>"); the placeholder `unidentified-agent` is never shown to a person | mcp-server suite 166/166 (new test for the label, round-trip test updated) |
| M8 / U4 | `approve` and `deny` are listed on the help page (group "Everyday work") and in "First steps" | CLI suite 368/368 (help tests pass); help output read |
| M9 | A failed or timed-out question now tells the agent to tell the person and call the tool again, or run the command themselves | mcp-server suite |
| T5 | The "build first" failure now names the exact commands. Through the repo-root `pnpm test`, turbo already builds first; only a package-level run lacked it | read |

Counts after this pass: fixed 12 (adds M3 and U4); partly done 5 (C3, U1, U2, M8 - now listed but still no `--watch` or alert, M9); open 14 (T1-T6, M1, M2, M4, M5, M6, M7, U3, U5 - M3 and U4 left the list); standing limits 5. The tables in section 3 above are the first-pass state.
Not changed, on purpose: `purix doctor` (U3) - the research note says do it after `start` is used. M5, M7, M1 change the MCP contract (structured pending status, cap behaviour) and need your decision.
Run: Linux only; `pnpm typecheck` through turbo failed in this container for core (`pnpm --filter ... typecheck` for core, mcp-server and cli all pass, as do the five gate scripts); I did not find why turbo fails.

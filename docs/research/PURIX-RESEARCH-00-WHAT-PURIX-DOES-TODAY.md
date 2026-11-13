# Purix: what it actually does today, from a request to an applied change

## Verification update, 2026-10-31 (method v2)

**Status under method v2: Reference (trace).** Pins: code `packages__2_.zip` d873c00c78b6822c; vault `purix-knowledge-working-2026-10-04.zip` 483002fb893b0085 (declared current by the owner on 2026-10-31, refresh after domain 16); Linux, Node 22.22.2; one run each. Full detail: `PURIX-RESEARCH-VERIFICATION-04-07-2026-10-31.md`. Probes: `research-verify-experiments/`. No finding below was deleted.

Not re-verified in this pass. Four statements in it are now independently confirmed by reading and by probes: the writer reads old content before writing (so an added path fails, see 04), the repair loop runs for every non-policy failure (07), the repair test lock is `isTestFilePath` (07), and `linkComponents` has callers only in `mcp-server/src/server.ts`, `cli/.../lifecycle.ts` and `core/manifest/store.ts` (05). Its stage annotations from 03 to 06 stand.

Prepared 2026-10-17 from `packages.zip` (the uploaded copy). This replaces the two audit files I sent earlier (`PURIX-AUDIT-00` and `PURIX-AUDIT-13`). Those were planning documents with codes and priority labels, and they were hard to follow. This one only describes the code, in order, in plain words. The research documents for each domain will build on it.

## Consolidation notes, 2026-10-29

**Number and role.** Document 00 in the sequence 00 to 06 (see `PURIX-RESEARCH-PLAN-2026-10-29.md`). It is the base trace, not a domain with picks, so it has no evidence levels. Every statement in it is "read from the code"; none is a measured rate. Code snapshot: `packages.zip` as uploaded on 2026-10-17; its hash was not recorded then. Statements were later spot-checked against `packages__2_.zip` (sha-256 d873c00c78b6822c) and held. 

**Where later documents change this trace.** Read these together with the stages below.

1. The apply stage writes each source file with a plain `writeFile` and has no re-check that the file is unchanged since verification. A diff that adds a file cannot be written at all. A crash between two writes leaves a mixed state that `reconcile` refuses to repair. See `PURIX-RESEARCH-04`, findings 1, 6 and 7.
2. The index stage builds no dependency edges for indexed or adopted code, `--incremental` and `--full` are never read, and the whole repository's symbols sit in one JSON row. See `PURIX-RESEARCH-05`, section 0.
3. The test stage can return "pass" when every test was skipped or no test exists (Vitest, Mocha, node:test), and a failure that does not reproduce on one re-run is forgiven. See `PURIX-RESEARCH-06`, section 1 and section 4.
4. The security stage corrections already listed below stand (`PURIX-RESEARCH-03`).

## Corrections made 2026-10-29 (from document 03)

Checked against the code and by experiment while writing `PURIX-RESEARCH-03` (details there, section 0).

1. Section 5 item 4 and stage 3 (the security gate): confirmed, and extended. The gate reads the whole new content of every file, not only the changed lines, so an old finding blocks an unrelated edit. The JavaScript rules run on every file type, so a README example is blocked. A crafted single line of 600 KB took 43 seconds to scan.
2. The typosquat check compares every dependency in `package.json`, not only added ones, and blocks real popular packages (`vite`, `tsup`). It does not look at Python manifests. No check asks whether a new package exists.
3. The vulnerability scan (`runVulnScan`) is not part of the change pipeline. It runs only from `purix audit`, and it reports "no known vulnerabilities" for pnpm and Yarn 4 projects, which it could not check.

## Corrections made 2026-10-18

Checked against the code while writing `PURIX-RESEARCH-02` (details in its section 9).

1. Section 5 item 2 (no time limit) is confirmed by experiment, and there is also no output cap beyond Node's 1 MiB default, which turns large output into a false failure.
2. Section 5 item 6 (the repository lock) is now traced. The lock covers every mutating command, but its refresh timer cannot run during synchronous verification, and a second process took the lock at about 38 seconds in my test.
3. Stage 4: the copy also includes build output (`dist`, `build`, `.next`, `target`), which is large in real projects.
4. Section 6: `state/repo_lock.ts`, `state/drift.ts`, `manifest/store.ts` and most of `manifest/indexer.ts` are now read.

## 0. How to read this

Every statement below comes from a source file I read, and I name the file. Where I looked for something and did not find it, I say "I did not find", which is weaker than "it does not exist". I did not run Purix, the build or the tests. I did not call any model.

The short version: Purix has a real pipeline, and its best parts are well built. But several things it appears to promise are weaker than they look, and the biggest one is that on Windows the sandbox does not isolate anything. Section 5 lists what I found.

## 1. The two ways a change enters Purix

**By instruction.** An agent or a person says "raise the retry limit to 5" (`purix modify`, `purix change`, or the MCP tools `purix_modify` and `purix_change`). Purix asks its own model to turn that into edits.

**By diff.** An agent has already written the code and hands over a patch (`purix ingest`, or the MCP tool `purix_ingest`). Purix reads the patch and does not ask a model to write anything. It does ask a model to label what kind of change it is (`classifyDiff` in `mcp-server/src/server.ts`).

Both routes then meet at one shared function, `resolveVerification` in `recovery/resolve_verification.ts`. That function is the heart of Purix: whatever the source of the change, the same verification, repair and escalation steps run.

## 2. Stage by stage

### Stage 0: the guard at the door (hooks)

An agent like Claude Code runs a small program, `purix hook`, before each tool call. `hooks/decide.ts` looks at what the agent is about to do. If the agent is writing a file that Purix governs, the hook says no and points the agent to `purix_change`. It uses no model and no network.

Three limits matter here:

- **It only knows about governed files.** A file becomes governed when it is registered as part of a component. A brand-new file, or a file nobody adopted, is not in the list, so the hook lets the write through. The guard protects what Purix already tracks, not everything in the project.
- **Shell commands are checked by text rules** (`screenShell`). The file's own comment says a command built from variables, an encoded string, or a script written first and run later gets past it.
- **The Claude Code hook watches `Edit`, `Write`, `MultiEdit`, `NotebookEdit` and `Bash`** (`hooks/install.ts`, line 33). The code knows how to screen a `powershell` tool (`hooks/protocol.ts`), but that name is not in the list Claude Code is told to send, and neither are MCP tools. Whether this matters on your machine depends on whether Claude Code's PowerShell tool is turned on there, which I could not check.

`docs/HOOKS.md` says no hook has been run inside a real agent yet. So this stage is built and unit-tested, not proven.

### Stage 1: understanding the request (instruction route only)

Purix sends the file to a high-tier model to restate the request, and asks the person to confirm the restatement. Over MCP, the person approves before any work exists, so they approve a sentence, not a result. (PURIX-33's AI-09 plans to fix this.) Then a cheaper model classifies the request into one of a fixed list of operations.

### Stage 2: turning the request into edits

The model never writes files. It proposes edits from a fixed list of five kinds, and `verify/compile.ts` applies them:

| Kind | What it changes | How it finds the place |
|---|---|---|
| `prompt_text` | Any exact piece of text | The old text must appear exactly once in the file |
| `config_value` | One value on a line | Finds the line by its key, swaps the value |
| `tool_binding` | One identifier | The old name must appear exactly once in the file |
| `error_handling` | A whole function body | Finds the function by name (TypeScript/JavaScript only) |
| `control_flow` | A run of `await` statements | Finds them by name (TypeScript/JavaScript only) |

If the request does not fit any of the five, the result is "unclassified", no edits come back, and the run goes to escalation. This is the main limit on what Purix can do by itself. Your earlier AI research covers this in detail.

### Stage 3: three cheap checks before anything runs

At the top of `verifyInSandbox` (`sandbox/sandbox.ts`), in this order:

1. **Secret scan** (`security/secrets.ts`). A hit stops the change.
2. **Security gate** (`gates/security_gate.ts`). This is a list of regular expressions applied one line at a time. It looks for SQL built by joining strings, shell commands built from variables, `eval`-like calls, weak hashes, reading the whole environment and sending it somewhere, and, for Python, the matching patterns. It also compares dependency names against a hard-coded list of 17 popular packages to spot misspellings. The code's own comment says a call split across several lines can get past it, and that it is "a tripwire that sends the patch to a person".
3. **Parse check** (`verify/precheck.ts`). If an edited file no longer parses, the change is refused before a copy is made.

A hit in 1 or 2 is marked a policy block. Repair and escalation are skipped for a policy block, because a model should not be asked to "fix" a security finding.

### Stage 4: the sandbox

Purix copies the whole project into a temporary folder, writes the changed files into the copy, and runs the project's own checks there. The copy leaves out `.env` and `.env.*`, `node_modules` (linked in instead), `.git`, and Purix's own state folder. Everything else is copied, including any other key or credential file in the project, and build output such as `dist`, `build`, `.next` and `target`.

Inside the copy, `provider.verify` runs the compiler (for TypeScript, `tsc -p` over the whole project using its real config), `provider.runTests` runs the related tests, and `provider.checkIdiom` produces style findings.

How isolated is that run? `sandbox/sandbox_exec.ts` decides:

| Platform | What happens |
|---|---|
| Linux with `bwrap` installed | Runs under bubblewrap: no network, read-only system folders, writes only to the copy. If bubblewrap is present but cannot start (common inside Docker), Purix stops with an error instead of quietly running unprotected |
| macOS with `sandbox-exec` | Runs under a profile that denies network and allows reads only from a short list |
| Anything else, **including all of Windows** | Runs the command directly, with no isolation, and reports `isolation: "none"` |

On every platform, the child process gets the parent's environment minus any variable whose name contains `API_KEY`, `SECRET`, `TOKEN`, `PASSWORD` or `CREDENTIAL` (`sandbox/sandbox_env.ts`). A variable like `DATABASE_URL` or `AWS_ACCESS_KEY_ID` does not match those words and passes through.

The TypeScript compile step is never isolated, on any platform. `verify/verify.ts` runs `tsc` directly and says so by returning `isolation: "none"`, and the overall result takes the weakest level.

### Stage 5: repair, then escalation

If verification fails and it was not a policy block, `recovery/heal.ts` asks a cheaper model for a fix, up to three times, each time verifying in the sandbox again. Each round sees the shaped failure and a short ledger of what it already tried. If three rounds fail, `recovery/escalate.ts` asks a high-tier model, up to two calls, with the neighbouring components included. If that fails, the run stops and nothing is written to your project.

### Stage 6: the trust gate

`gates/trustgate.ts` decides whether Purix commits by itself, asks a person, or aborts. In order:

1. The classifier suspected prompt injection: ask a person.
2. A test's assertions were weakened or removed: ask a person.
3. No related test exists for the changed file: ask a person.
4. Model confidence below 0.35: abort.
5. Confidence 0.75 or higher, not contract-changing, but verification ran with no isolation: ask a person.
6. Confidence 0.75 or higher and not contract-changing: commit automatically.
7. Everything else: ask a person.

The confidence number is the classifier's own opinion of how well the change fits its label. The prompt tells it that this is not a judgement of whether the code is correct. It is still the number that decides between automatic commit and a question to the person.

### Stage 7: writing the change

`entrypoints/modify.ts` reads the current content of each file into memory as a backup, then writes the new content over each file one at a time with a plain `writeFile`. If one write fails, it writes the backups back. If rollback also fails, it says which files are now inconsistent. After a successful write, `manifest/commit_and_cascade.ts` records the new version, computes a hash of the files, and appends an entry to the audit chain. The committed lock file (`purix.lock.json`) is refreshed.

Purix's own state files (the store, usage ledger, hook configs) are written through `platform/atomic_write.ts`. The project's source files are not.

## 3. What happens after, outside the pipeline

- `purix check` reads the disk and answers whether governed files still match what Purix recorded and whether the audit chain is intact. It never writes.
- In CI, `purix lock` and `purix check --strict` repeat that against a fresh checkout. `docs/CHECK.md` says a person who edits a governed file and the lock in the same commit passes it, and advises making it a required check with code-owner review.
- When Claude Code or Codex finishes a turn, the Stop hook lists governed files that changed outside Purix, and cannot undo anything.

## 4. What is solid

These are worth keeping and are not the problem:

- One shared verification function for both routes, so no route gets a special exemption.
- A fixed, small set of edit kinds, applied by deterministic code that fails loudly.
- Policy blocks that skip repair, so a model is not asked to rewrite around a security finding.
- The sandbox refusing to quietly fall back when bubblewrap exists but cannot start.
- The isolation level travelling with the result, so the trust gate can ask a person when verification ran unprotected.
- Repair that cannot edit test files, and a trust-gate step for weakened test assertions.
- An audit chain and a committed lock that make after-the-fact tampering visible.
- Unreadable state failing closed in the hook, and a crash in the Stop hook failing open.

## 5. What is not problem-proof

Ordered by how much each weakens the promise that bad code cannot reach your project.

1. **On Windows, nothing is isolated.** Generated code and its tests run directly on your machine, with your network and your files, using a stripped environment. The trust gate does respond to this, by asking a person before committing, but the code has already run by then. The test run is where the risk is, not the commit.
2. **I found no time limit on a test or compile run.** The process wrapper in `platform/spawn_sync.ts` has no timeout, and I found none in `verify/tests.ts` or `sandbox_exec.ts`. A generated test that never ends would hang the run. I also found no memory or process cap, other than what bubblewrap or the OS applies by default.
3. **The sandbox copy is broader than it needs to be.** Any credential file in the project other than `.env` is copied, and, on Windows, readable and network-reachable by the code under test. The environment filter works by variable name, so `DATABASE_URL`, `AWS_ACCESS_KEY_ID` and similar names pass through.
4. **The security gate is a line-by-line pattern list.** It will catch the textbook cases. A call split over two lines, or built another way, will pass it. The typosquat check covers only 17 package names, and nothing checks whether a newly added package exists on the registry or how old it is.
5. **The automatic-commit decision rests on a model's own confidence.** A change that fits its label well but is wrong in behaviour can still score above 0.75. The tests are the real check, and the gate does require a related test to exist. What it checks is that a test is related to the file, not that the test exercises the changed lines.
6. **Writing the change is not atomic, and I did not find a check that the files are unchanged since they were read.** If the process is killed in the middle of the write loop, some files are new and some old. If a person or another agent edits a file between the read and the write, the write would overwrite it. A repository lock exists (`state/repo_lock.ts`), and I did not trace whether it covers this window. (Traced later, see the corrections above: it is taken at the start of each mutating command, but loses exclusion after about 30 seconds of synchronous work. I did not find a second check right before the write.)
7. **The door only guards governed files**, as described in stage 0.
8. **Real agent behaviour is unproven.** The hooks, the approval-by-elicitation path and the per-agent formats have tests against recorded or documented payloads, not live runs.

## 6. What I have not read yet

Each of these is needed before its domain document can be written. I will read them as I go, and say so when I do:

- `llm/classify.ts` and the seven prompts (partly covered by your earlier AI research).
- `verify/test_integrity.ts`, `verify/tests.ts` and `language/providers/*` in full, for how "tests passed" is decided.
- `state/reconcile.ts`, for concurrency (`state/repo_lock.ts` and `state/drift.ts` were read later).
- `manifest/resolver.ts`, `library.ts` and `adopt.ts`, for how components are found again (`manifest/store.ts` and most of `manifest/indexer.ts` were read later).
- `tools/broker.ts`, for how project tools are found and trusted.
- `security/audit_tamper_evidence.ts`, for the audit chain's actual construction.
- The private repo, which was not uploaded.

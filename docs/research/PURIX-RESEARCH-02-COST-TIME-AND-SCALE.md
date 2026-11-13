# Cross-cutting research 02: cost, time and scale

## Verification update, 2026-10-31 (method v2)

**Status under method v2: Settled with gaps.** Pins: code `packages__2_.zip` d873c00c78b6822c; vault `purix-knowledge-working-2026-10-04.zip` 483002fb893b0085 (declared current by the owner on 2026-10-31, refresh after domain 16); Linux, Node 22.22.2; one run each. Full detail: `PURIX-RESEARCH-VERIFICATION-04-07-2026-10-31.md`. Probes: `research-verify-experiments/`. No finding below was deleted.

Not re-verified in this pass. One number is now known to be unstable: indexing cost per file. Three sessions gave 2.1 to 2.7 s (synthetic chain), 3.6 to 6.4 s (zod subsets, superlinear) and a curve from 21.6 s at 10 files to 390.5 s at 80 files. Treat every figure derived from them as level C until three runs at three sizes on one real repository are recorded. All million-line figures remain extrapolations.

Prepared 2026-10-18 from the uploaded `packages` code, the `purix-knowledge` vault snapshot, `PURIX-RESEARCH-00`, `PURIX-RESEARCH-01`, `PURIX-33`, the second-edition AI research, and primary sources found today. This is the document the handoff was missing. It does not cover one domain. It covers one question that cuts across all of them: what does each part of Purix cost in time and resources, how does that cost grow with the size of the repository, and how do mature tools keep such costs bounded. It ends with one cost-management model, a verdict on whether Purix needs one codebase or two, and corrections to `PURIX-RESEARCH-00` and `PURIX-RESEARCH-01` that came from checking them against the code.

## Consolidation notes, 2026-10-29

**Number and status.** Document 02, cross-cutting. Status: **settled with gaps**. Code snapshot: `packages.zip` as uploaded on 2026-10-17; its hash was not recorded then. Statements were later spot-checked against `packages__2_.zip` (sha-256 d873c00c78b6822c) and held. 

**Evidence levels.** Not graded pick by pick. Measured items are single machines with one run per size unless a correction says otherwise (the method review, finding 4). Read any pick that is not marked measured as level C or D, **not yet shown to improve results**. Every figure about one million lines is an extrapolation until the large-repository pilot in the plan has run.

**Corrections from documents 04, 05 and 06.**

1. Indexing cost: replaced in place (finding 1, the tier table, section 2 notes and the options table). The wording "files squared" and the 12-hour figure are withdrawn.
2. Task 2.5 (cascade after a contract change) and its cost model: the cascade and the neighbour context have no edges to act on for adopted components, so the cost estimate holds only for created components whose edges the model declared (`PURIX-RESEARCH-05`, finding 1).
3. Test selection seeds: test discovery stops at 20,000 files and then reports `uncovered: 0` (`PURIX-RESEARCH-06`, section 2). The failed-test re-run repeats the whole set for Jest, Vitest and Mocha, and one re-run forgives a failure that does not reproduce (section 4 there).
4. Mechanics cost: anchor matching and AST transforms are small beside verification (4.6 ms and 3.8 s at 200,000 and 50,000 lines; `PURIX-RESEARCH-04`, task 9). The only mechanics cost worth a cap is the "anchor not found" explanation (2.8 s at 200,000 lines).

## Corrections made 2026-10-29 (from document 03)

Checked while writing `PURIX-RESEARCH-03` (details there, section 0).

1. The security gate and scan cost "follows the size of the change": true for normal code (16.6 MB in 173 ms, measured), false for crafted input. One 600 KB line took 43 seconds, and doubling the size multiplied the time by about four. That is longer than the repository lock's 30-second window (finding 4 of this document).
2. Section 1 says `deps_audit.ts`, `input_scan.ts` and `injection.ts` were not read. They are now read. The vulnerability scan is not in the change pipeline and gives a false clean for pnpm and Yarn 4.
3. The line "A check against a registry would add a network call per new dependency (expected)" is now measured from one Linux workspace: 46 to 189 ms per name on npm and 81 to 126 ms on PyPI.

## 0. Read this first

**What "large" means here.** You did not give a number. I assumed a large company is a repository of about one million lines or more, tens of thousands of files, and 100 or more developers, with coding agents working in it all day. Every scale statement below is judged against that. Change the assumption and the numbers move, not the structure.

**What this document is for.** Purix is paid for by large companies. In a large repository, a verification layer that costs a little per change in a small project can cost hours, or fail to run at all. The first two research documents asked "is it safe?" and "is it correct?". This one asks "does it stay usable when the project is big, and what does it cost to run?"

**Findings that matter most.**

1. **Verification cost is paid once per file, and it is large.** On synthetic TypeScript projects, indexing took 2.2 seconds per file at 10 files and 4.9 seconds per file at 80 files (10 files: 21.6 s; 80 files: 390.5 s, one run each). The cause is in the code: for every file indexed, Purix copies the whole project and compiles the whole project. **Corrected 2026-10-29:** three repetitions in `PURIX-RESEARCH-05` found 2.1 to 2.7 seconds per file at 10, 20 and 40 files, and the 126.7 s point at 40 files did not reproduce (84.0 to 86.5 s). Another session measured 3.6 to 6.4 seconds per file on a different machine and project. So the supported statement is 2 to 6 seconds per file, roughly linear up to 40 files; the earlier "grows faster than the file count" reading and the fitted figure of about 12 hours for 1,000 files are not supported. Growth beyond 40 files has not been measured. The consequence stands: at 2 seconds per file, 1,000 files take over half an hour and 10,000 files over five hours, which is still not usable for a large company (arithmetic on the measured rate, not a measurement).
2. **Every single change pays the same whole-repository costs.** Each verification copies the whole project, runs `tsc -p` over the whole project, and scans every source file to find related tests. After the commit, the lock refresh hashes every governed file of every component. None of these depends on how big the change is. The consequence: a one-line edit costs the same in a repository of 50,000 files as a rewrite.
3. **There is no time limit and no output limit on any run, and the missing output limit turns into a false code failure.** A child process that never ends was not stopped within 15 seconds in my test. Output above 1 MiB makes the process wrapper return an error with the output dropped, and Purix reports that as a failed test or compile. The repair loop then tries to fix code that was never wrong. This is inferred from reading the callers; I did not run a full repair against it.
4. **The repository lock stops protecting you after about 30 seconds, and I reproduced it.** The lock refreshes itself from a timer, and verification runs synchronously, so the timer cannot fire while a verification is running. A second process took the lock at about 38 seconds while the first was still working. Any change that takes longer than about 30 seconds can overlap with another change on the same checkout.
5. **ADR-002's amendment log decided two limits that the code does not enforce.** The log (2026-08-05) sets a provisional 2 GB memory ceiling per sandboxed process and a pre-commit gate latency target of P95 under 2 seconds. I searched the code for memory limits and any latency target and found neither. `PURIX-RESEARCH-01` did not read the amendment log. The measured cost of one verification, already above 2 seconds at 10 files, means the target cannot be met by the current design.
6. **Dependents are re-verified against your real project folder, not a copy.** After a contract-changing commit, the cascade runs the compiler and the tests on each dependent with the real project as both working folder and writable folder (`verify/impact.ts` line 53, `verify/tests.ts` lines 228 and 276). On Linux with bubblewrap, test code in the cascade can write to your real files. This contradicts a statement in `PURIX-RESEARCH-01` (correction 1 below).
7. **The slow parts have known fixes with measured evidence behind them.** Affected-only work, input-hash caching, predictive test selection, incremental compilation, sparse and fsmonitor git, and tiered verification are all used at Google, Meta, Microsoft and Uber, and each has published numbers. Section 4 gives them.
8. **One number deserves less worry than I expected.** The hook that guards every agent write reads and parses the whole manifest on each tool call. On synthetic data, parsing took 3 ms at 1,000 components, 47 ms at 10,000 and 118 ms at 50,000. Process start-up will cost more than that. This is smaller than I feared, and it is still the cheapest thing to fix.
9. **Interactive time needs a budget per tier, not one number.** The research on response times and on how Google, Meta and Facebook run analysis converges on layers: an instant check, a seconds-scale check while the person waits, and a minutes-scale check that runs in the background or in CI. Purix has one tier and it is the slow one.
10. **One codebase with configuration, not two.** GitLab ran two repositories for its two editions, measured the cost, and merged them. For one developer, two copies would mean every fix is made twice. The enterprise differences (remote workers, a shared cache, team budgets, merge-queue integration) are features, not a different engine (section 6).
11. **Part of the market fit is open.** Purix verifies TypeScript and Python in the beta. I did not research the language mix of large companies, and I assume Java, C# and Go are common there. The cost problems differ for those toolchains. This belongs to the language domain.

**What is already good and should not be touched.** The shared verification function for both routes (the cost fixes apply to both at once). The cheap checks before the copy: the secret scan, the security gate, and the parse check. They cost time proportional to the change, not the repository. Repair that skips policy blocks (no wasted model calls). The circuit breaker for failing model calls (`llm/circuit.ts`: five failures, 60 seconds). The audit chain's pruning with checkpoints. The flaky-test history window of five (`manifest/test_history.ts`), which keeps that table bounded. The lazy loading of heavy modules in `cli/src/cli.ts`.

## 1. How I worked, and what I could not check

**Read in the code:** `platform/spawn_sync.ts`, `sandbox/sandbox.ts`, `sandbox_exec.ts`, `sandbox_env.ts`, `verify/verify.ts`, `verify/tests.ts`, `verify/test_discovery.ts`, `verify/impact.ts`, `manifest/indexer.ts`, `manifest/store.ts`, `manifest/commit_and_cascade.ts`, `manifest/test_history.ts`, `state/landed_change.ts`, `state/governed_lock.ts`, `state/repo_lock.ts`, `state/drift.ts`, `hooks/run.ts`, `hooks/decide.ts`, `hooks/install.ts`, `recovery/heal.ts`, `escalate.ts`, `resolve_verification.ts`, `llm/circuit.ts`, `gates/trustgate.ts`, `gates/security_gate.ts`, `security/audit_tamper_evidence.ts`, `language/providers/typescript.ts`, `tools/catalog_data.ts`, and the start-up hook in `cli/src/cli.ts`. From the vault: ADR-002 including its amendment log, ADR-036, ADR-064, ADR-067, PURIX-15, PURIX-19, IDEA-073.

**Experiments I ran** (2 CPUs, 8 GB memory, Node 22, no bubblewrap on this machine, so the "no isolation" path):

- **Scaling benchmark.** `runIndex` on synthetic TypeScript projects, each source file with one paired test file. Files: 10, 20, 40, 80. Total time: 21.6, 48.0, 126.7, 390.5 seconds. No failures.
- **Output cap.** `spawnSync` with 900 KB of output works. With more than 1 MiB it returns `exitCode: null` and an `ENOBUFS` error text, and the output is dropped.
- **No time limit.** A child that never ends did not return within 15 seconds. My outer timer killed it.
- **Lock takeover.** Process A took the lock and then ran a blocking 42-second command. Process B at 20 seconds was refused ("already locked by active process"). Process B at about 38 seconds printed that it was clearing an abandoned lock and took it, while A was still working.
- **Manifest parse.** A synthetic SQLite table with one large index row plus one row per component: 1,000, 10,000 and 50,000 components, 0.6, 5.6 and 28.2 MB. This measures the select and the JSON parse only, not Purix's own hook.

**Limits of the experiments.** The projects are tiny and synthetic, so the per-file constants will differ from real code; the shape of the growth is what the code explains. Two CPUs. No isolation backend. I did not measure Windows or macOS, and the Windows copy cost is unmeasured. The 1,000-file figure is a fit to four points of the form `a·F + b·F²` (a about 1.46, b about 0.043) and is an estimate. The manifest rows in the hook test are smaller than Purix's real rows, which carry version history, so real parse times will be higher.

**Primary sources used:** listed in section 10, each labelled. Where I could read only an excerpt, it says so.

**Not done, and not verified:**

- **No real large repository.** I measured no repository above 80 files. A pilot on a public large TypeScript project, and then on one of a design partner's, is the missing evidence.
- **Pages I was not allowed to open.** The Node.js `child_process` page, the Anthropic prompt-caching page, the AWS Builders' Library page on timeouts, the ACM Communications page for the Google monorepo paper, and one university-hosted PDF were refused by the fetch tool. I did not work around that. Node behaviour was checked by experiment instead. I could not verify prompt-caching multipliers, AWS timeout guidance, Google's monorepo size figures, or the default timeouts of Jest and Mocha.
- **Code not read:** `llm/budget.ts` and `call_log.ts` in detail, `lifecycle.ts`, `state/reconcile.ts`, `tools/broker.ts`, `classifyDiff` in the MCP server, the Python provider's internals, `llm/input_scan.ts`, `llm/injection.ts`, `security/deps_audit.ts`, `manifest/resolver.ts`, `library.ts`, `adopt.ts`, `usage/`, `docs/compliance/`, and `.github/workflows`. The cost inventory for those parts is marked as expectation, not finding.
- **Not run:** the Purix test suite, any call to a model, any real bubblewrap, macOS or Windows backend.
- **Not tested:** merge conflicts on the committed lock file with two developers; whether a TypeScript incremental build file made in the real project can be reused inside a copy; whether the index step sets a "pass" status that other parts rely on.
- **Not researched:** the language mix of large companies; build systems for Java, C# and Go.

## 2. What the cost of one change is today, in one paragraph

An agent's write goes through the hook (a Node process start, a manifest read, text rules). A change handed to Purix runs the secret scan, the security gate and a parse check, then copies the whole project minus a few folders (`dist`, `build` and `.next` are copied), links `node_modules`, writes the candidate, runs `tsc -p` over the whole project, scans the whole repository for related tests (reading up to 1 MB per file, capped at 20,000 files with a `truncated` flag), runs those tests, and runs the style check, all in one blocking thread. A failure starts up to three repair rounds on the cheaper model and then up to two on the stronger model, with one sandbox verification after each, so a worst-case change has about six verifications and about five repair calls, and up to about ten if the one bounded format retry fires on each (my reading of `heal.ts`, `escalate.ts` and PURIX-33). A failing test is recorded and then re-run, and for Jest, Vitest and Mocha the re-run repeats the whole test-file set, not the one failed test (`verify/tests.ts`). A pass leads to the write, the manifest commit, the audit record, a refresh of `purix.lock.json` that rehashes every governed file, and, if the contract changed, a re-verification of each dependent against the real project. Nothing in this sequence is limited by time, output size, memory or process count.

## 3. The cost inventory, concept by concept

For every domain from the handoff, every task of `PURIX-RESEARCH-01`, and the fourteen concepts of PURIX-33. Each line says what the cost is and how it grows. The word "read" means I read the code; "measured" means I ran it; "expected" means I did not read that code and I am stating what the design implies.

The table compares how each step grows. It covers the steps I read or measured.

| Step | Grows with | How I know |
|---|---|---|
| Hook parse of the manifest | Number of components | Read; parse measured at 3, 47, 118 ms for 1k, 10k, 50k components |
| Secret scan, security gate, parse check | Size of the change | Read |
| Whole-project copy per verification | Size of the project | Read; part of the measured total |
| `tsc -p` per verification | Size of the project | Read; part of the measured total |
| Related-test discovery | Number of files, up to a 20,000 file cap | Read |
| Failed-test re-run for Jest, Vitest, Mocha | Number of test files, times number of failed tests | Read |
| Indexing | About 2 to 6 s per file (copy and compile per file); growth beyond 40 files not measured | Read and measured |
| Dependents cascade | Number of dependents, each at whole-project cost | Read |
| Lock refresh after each change | Number of all governed files | Read |
| Audit chain append | Constant per event | Read |
| Audit chain check | Number of records not pruned | Read |
| Repair loop | Up to 6 verifications and 5 or more model calls per change | Read |

### Sandboxing and isolation (`PURIX-RESEARCH-01`, tasks 1 to 8)

- **Task 1, the copy.** Time, CPU and disk all grow with project size, once per verification and once per repair round. The copy filter leaves out `node_modules`, `.git` and state, not build output. Windows copy cost not measured. Complication: a large monorepo may not fit in the temporary folder.
- **Task 2, the boundary.** Bubblewrap start-up is small per call (not measured). On Windows there is no boundary, so there is no cost and no protection. Complication: bubblewrap does not start inside default Docker, which is where most CI runs.
- **Task 3, limits.** There are none; the cost is unbounded by design. This document's Task 1 covers it.
- **Task 4, network.** No cost in time. Complication: tests that need a database or a network call fail under network denial (inferred), so large companies with integration tests will see false failures.
- **Task 5, secrets and environment.** The scan reads every candidate file once; the cost grows with the change. Complication: environment names that pass the filter.
- **Task 6, writes.** No cost. The cascade finding (finding 6) is a correctness cost of skipping the copy for dependents.
- **Task 7, the label.** No cost.
- **Task 8, conformance suite.** CI time on three operating systems, and one runner per platform. Expected: small per run, larger in runner minutes.

### Security of generated code and supply chain

- **Gate and scan.** Per-line regexes over changed files; cost grows with the change, not the project. Good at scale.
- **Package checks.** The 17-name typosquat list costs nothing. A check against a registry would add a network call per new dependency (expected, `deps_audit.ts` not read). Complication: registry calls need a proxy in company networks.
- **Future static analysis.** CodeQL and Semgrep full scans grow with the repository; their diff-aware modes cost less and lose cross-file results (Task 3 below).
- **Review load.** At 100 developers, false positives become human time. Google's code-review analyser kept effective false positives under 10% for this reason.

### Verification and test trust

- **Related-test discovery.** Read: walks the whole repository on every call and rebuilds a reverse import graph; the cap of 20,000 files is a quiet limit and the result carries `truncated`. Time and memory grow with the repository. Complication: a company repository above the cap gets incomplete test selection.
- **Running tests.** Grows with the selected tests; selection quality is what keeps it bounded.
- **Quarantine re-runs.** A failed test is recorded and the whole file set re-runs for Jest, Vitest and Mocha. Cost grows with the number of failures times the set size.
- **Flaky tests.** The history window is five, so storage is bounded. Meta retried failures up to ten times to detect flakiness; Google found 2.07% of targets both pass and fail. At large scale flaky tests are a large part of the cost.
- **Mutation testing (not built).** Google reported that evaluating one mutant takes several minutes, and capped surfaced mutants at 7 times the files in a change. Not affordable per change without selection.

### Deterministic change mechanics

- **Edits, matching, AST transforms.** Cost grows with the size of the edited files. The parse of a very large generated file could be slow (not measured).
- **Write step.** Grows with the files in the change; no cost at project scale.
- **Formatter normalisation (proposed in the handoff).** One more tool run per changed file; small.

### Self-healing and repair

- **Model tokens and time.** Up to about five repair calls and six sandbox verifications. The time multiplier is about six, and each verification is a whole-project cost, so a failing change in a large project is the worst case for both time and money.
- **Early stop.** `healEarlyStopEnabled` exists in `heal.ts` and is off by default.
- **Complication.** Infrastructure failures (timeout, output limit, sandbox cannot start) look like code failures to the loop.

### State integrity, concurrency and atomic apply

- **Repository lock.** Per checkout. Cost is nothing; correctness fails after about 30 seconds (finding 4).
- **Lock file refresh.** Hashes every governed file after every change. Grows with the whole project. The committed lock is one shared file, which I expect to be a merge hotspot with many developers; not tested.
- **Store.** SQLite with a 5-second busy timeout. `listManifest` parses every row.
- **Start-up reconcile.** Each mutating command checks pending operations first; cost grows with the number of pending operations, normally zero.

### Interception and enforcement

- **Per tool call.** A Node process start, a manifest read and parse, a linear loop over the governed map and the text rules. Parse measured small; start-up not measured. The Claude entry has no timeout in the hook entry; Codex and Cursor use 10 and Gemini 10000 (the unit of each is that agent's own).
- **Complication.** The protected list is partial, so a cost-saving shortcut here (skipping files) would be a security cost.

### Governance, policy and audit

- **Audit append.** Constant per event.
- **Audit check.** Grows with the records not pruned; `pruneAuditChain` with checkpoints exists. I did not find what calls it.
- **Trust gate.** Constant.
- **Human approvals.** The real cost at scale is attention. Anthropic reports people accept about 93% of permission prompts (second-edition research, secondary), so more prompts add time without adding protection.

### Component model, store and retrieval

- **Indexing.** Measured: 2 to 6 seconds per file, one whole-project copy and compile per file; the "files squared" reading did not reproduce (`PURIX-RESEARCH-05`); growth beyond 40 files is unmeasured (finding 1). The index is stored as one very large manifest row and again as `components.json`.
- **Retrieval.** `resolver.ts` not read.
- **Complication.** Index shared across 100 developers: each developer indexes alone today. Cursor reports 92% of a typical clone matches a teammate's, which is the size of the saving from sharing.

### Language support and providers

- **Each provider shells out to a toolchain.** Start-up per call plus the toolchain's own cost. Python provider internals not read.
- **Complication.** TypeScript and Python only. Large companies likely use Java, C# and Go (my assumption); their builds can take minutes and use Gradle, Maven or MSBuild.

### Tool broker and toolchain

- **First-run cost.** Finding and possibly installing tools: network, disk, time. The pinned fallback TypeScript is 5.7.2 (`tools/catalog_data.ts`). `broker.ts` not read.

### Code quality gates

- **Style check.** Runs in the sandbox per verification; expected to grow with the changed files. Not read in detail.

### Observability, replay and reliability

- **Per-call record, event log, usage ledger.** Disk grows with calls. I searched `events.ts`, `call_log.ts`, the usage ledger and `test_history.ts` for pruning, retention or a row limit and found none except the history window. That is a finding about those four files, not about the whole code.
- **Circuit breaker.** Bounds model calls during an outage (five failures, 60 seconds).

### Code comprehension

- **Symbol index and focus.** Cost of building and refreshing it; shares the indexing problem. Context size and tokens are PURIX-33's.

### Evals and honest measurement

- **Eval pack.** Model tokens, money and CI time per run. A budget per run is needed before it is added to CI.

### Compliance and data governance

- **Expected, not read.** Retention of audit and call data across 100 developers; storage and access controls. `docs/compliance/` not read.

### SDLC (bounded) and Purix's own release

- **SDLC.** PURIX-33's.
- **Release.** Expected: a build and test matrix across three operating systems; runner minutes. `.github/workflows` not read.

### PURIX-33's fourteen concepts

- **Edit format (1), tier routing (6), output format (7).** The one bounded format retry can double a call's cost.
- **Check before landing (2).** A cost saver: the parse check fails early before a copy.
- **Prompt size (4), what code the model sees (3).** Tokens per call; the ledger adds some and removes repeated failure text.
- **Repair loop (5).** See self-healing above.
- **Guiding agents (8), finishing (9), MCP surface (10), project state (11).** Small, mostly tokens in tool descriptions per session.
- **Measuring (12).** A per-call record: disk, and a little time per call.
- **Security (13).** Scans on repair input and memory lines: small.
- **Usability (14).** Approval of the result puts a person's wait inside the path.

## 4. The tasks, with the research on each

Each task has a quality bar, options with evidence and weakness, a best way, and a verdict under the two rules of the handoff. Targets I propose are marked as mine.

### Task 1. Bound every run

Quality bar: no single process can run past its deadline, grow output past its cap, use memory past its ceiling, or leave children behind. A stop for any of those is reported as an infrastructure result, never as "the code failed", and the repair loop never receives it as a failure to fix. A test that proves it: the hostile set from `PURIX-RESEARCH-01` task 8 returns within the deadline on every platform.

#### 1.1 A deadline on every spawn, and a budget over the whole change

**Today.** `platform/spawn_sync.ts` sets no `timeout`, `killSignal` or `maxBuffer`. A never-ending child did not return in my 15-second test.

**What it should do.** Google's SRE guidance on cascading failures says to always set deadlines and not to set them orders of magnitude above the mean. It also says retries must be bounded with randomised backoff, and shows retries multiplying across layers (a call retried four times at three layers becomes 64 attempts). Purix has three layers: a format retry, repair rounds and escalation.

| Option | Evidence | Weakness |
|---|---|---|
| A. No limit (today) | None | One hung test freezes the run and, through the lock, the checkout |
| B. `timeout` with `SIGKILL` on the spawn call | Node documentation (cited in `PURIX-RESEARCH-01`; I could not reopen the page today) | Does not kill grandchildren on Windows or macOS; blocks the thread |
| C. Async spawn with a deadline timer and a tree kill | Needed anyway for the lock heartbeat (Task 6) | A larger code change |
| D. Per-step deadlines under one budget per change, set from measured P95 times | SRE advice on deadlines | Needs timing data first; start with a fixed default |

**Best way.** C with D. The deadline for each step starts at the `PURIX-RESEARCH-01` rule (three times the project's measured P95, with a fixed default until there is data) and sits under a budget for the whole change, so repair cannot exceed it by multiplying. B stays as the fallback in synchronous code paths. **A combination reaches the bar.**

**How we would know.** The never-ending and the sleeps-in-a-grandchild programs return in time with "timed out" and no process left.

#### 1.2 An output cap, reported as its own result

**Today.** I measured that output above 1 MiB returns `exitCode: null`, an error text with `ENOBUFS`, and no stdout. `verify/tests.ts` treats a null exit code with no parsed tests as a failure carrying the stderr text. That text goes to the repair loop (my inference from reading the call path).

**What it should do.** Large test suites and verbose compilers in a large repository will produce more than 1 MiB. The cap must be a decision, not a crash.

| Option | Evidence | Weakness |
|---|---|---|
| A. Default cap, reported as failure (today) | Measured | False failures; repair wastes calls |
| B. Raise `maxBuffer` | Node option | Moves the limit, does not remove it; memory grows |
| C. Stream output to a file with a size cap and parse the file; return "output limit reached" as a separate result | My proposal; the same idea is how mature runners avoid memory growth | Test-runner parsers must read from a file |
| D. Ask the runner for quiet or summary reporters | General practice, not verified | Loses detail the repair loop uses |

**Best way.** C, with D as a default for the large-project profile. An output-limit result is not a code failure and does not enter repair.

**How we would know.** The print-100-MB program ends with the infrastructure result, the machine's memory does not grow with the output, and no repair call is made.

#### 1.3 Memory and process ceilings

**Today.** None. ADR-002's amendment log decided 2 GB per subprocess (Windows Job Object, Linux cgroup or `RLIMIT_AS`, `ulimit` elsewhere) and I found none of it in the code.

**What it should do.** Meet the ADR. The bubblewrap manual describes `--size` for the temporary file system and a tmpfs overlay for writes, which count against memory; it does not give a general memory cap. A real ceiling needs a cgroup, `prlimit` or `ulimit`.

| Option | Evidence | Weakness |
|---|---|---|
| A. None (today) | None | A leaking test takes the machine |
| B. Job Object on Windows | Microsoft documentation, from `PURIX-RESEARCH-01` | Needs a native helper from Node |
| C. `ulimit` or `prlimit` before the command | Standard tools | Address-space limits can break runtimes that reserve large ranges; I did not verify this for Node |
| D. cgroup, via `systemd-run` | `PURIX-RESEARCH-01` left it open | Often needs privileges |

**Best way.** C on Linux and macOS now, with a measured ceiling check in the conformance suite, and B with the Windows work. D only if the conformance run shows C failing. This is a combination, and ADR-002's number stays "provisional" until measured on a real project.

**How we would know.** The allocate-4-GB and fork-bomb programs end with a resource result inside the deadline.

#### 1.4 Retry and repair budgets

**Today.** Three repair rounds and two escalation calls (`heal.ts`, `escalate.ts`), early stop off by default, one bounded format retry per PURIX-33.

**What it should do.** The SRE book's guidance is to bound retries and to retry once per layer at most where layers stack. PURIX-33 already chose three rounds "until measured".

| Option | Evidence | Weakness |
|---|---|---|
| A. Fixed 3 plus 2 (today) | In the code | Cost per failing change is about six verifications at whole-project cost |
| B. Turn on early stop | Exists in `heal.ts` | I did not measure its effect |
| C. A change budget in seconds and tokens, whichever ends first | SRE guidance on bounded work | Needs the per-call record from PURIX-33 first |
| D. An org-level spend limit | Claude Code's cost documentation describes workspace spend limits and per-user rate-limit recommendations by team size | Needs the budget sync of ADR-036 |

**Best way.** B now (a switch that exists), C when the per-call record lands, D for the enterprise profile. Infrastructure results bypass the loop (1.2). This task as a whole: **a combination reaches the bar.**

**How we would know.** Worst-case seconds and calls per change are displayed before the run; the number of repair rounds that followed an infrastructure result is zero.

### Task 2. Make the cost follow the change, not the repository

Quality bar (my target): doubling the repository while keeping the change the same adds less than about 20% to the verification time of that change. A test: the same one-line edit on the 1k, 10k and 100k-file benchmark repositories (Task 8).

#### 2.1 The verification copy

**Today.** `cpSync` of the whole project minus `.env`, `.env.*`, `node_modules`, `.git` and `.purix` (`sandbox/sandbox.ts`). Build output is copied.

**What it should do.** ADR-002 decided to copy the affected files with a full-copy fallback. Bazel's documentation describes a different approach: a directory of symbolic links to the declared inputs, rarely more than a few percent slower on Linux, and it notes that sandboxing disables tool caches and that a reuse option cuts set-up cost. Bubblewrap supports overlays, where the real tree is read-only and writes go to a temporary layer in memory.

| Option | Evidence | Weakness |
|---|---|---|
| A. Full copy (today) | Read | Time, disk and CPU grow with the project; per-file cost measured at 2 to 6 s; the quadratic reading is not supported (see corrections) |
| B. Exclude build output and caches | Obvious; the filter exists | Small saving; a list to maintain |
| C. Affected files plus lockfiles and config, full fallback (ADR-002) | The vault decision; the import graph exists | A wrong affected set gives false failures, so the fallback must be reliable |
| D. Link tree to the real files, with only the candidate files written as real files | Bazel documentation | A write through a link reaches the real file unless the link target is read-only; on Windows Purix has no read-only enforcement |
| E. Read-only mount of the real tree plus an overlay for writes | Bubblewrap manual | Linux only; writes use memory |

**Best way.** By platform: Linux, E; macOS, D with a read-only profile for the source tree; Windows, C, because there is no enforcement that makes D safe. B everywhere first. The platform split is a consequence of the evidence: the cheap option is safe only where the boundary enforces read-only. **A combination reaches the bar.**

**How we would know.** Copy time and disk for the one-line edit stay flat across the three benchmark sizes; a test that writes through a link in the copy leaves the real file unchanged.

#### 2.2 The compile step

**Today.** `tsc -p` over the whole project, every time, for every dependent after a commit (`verify/verify.ts`, `verify/impact.ts`).

**What it should do.** The TypeScript handbook describes project references and `tsc -b` for building only what changed. The TypeScript team's release notes for `--incremental` give 47.54 seconds for a baseline and 11.49 seconds for a later build with no change to the public shape, on the VS Code project (vendor-run). A native TypeScript 7 compiler was released on 2026-08-03; a secondary report gives full builds 8 to 12 times faster (VS Code project 125.7 s to 10.6 s; one company's CI type check from 7.5 to 1.25 minutes) and says nothing about incremental or build mode, so I treat it as an option to test, not a fact.

| Option | Evidence | Weakness |
|---|---|---|
| A. Whole project each time (today) | Read | Grows with the project |
| B. Incremental build file kept outside the copy | TypeScript release notes (vendor-run) | Whether a build file from the real project is valid in a copy is untested; the project must enable it |
| C. Project references and `tsc -b` | TypeScript handbook | Needs the project to use references |
| D. Native compiler (TypeScript 7) | Secondary report | Not checked for build mode; a provider conformance run is needed |
| E. Skip the compile in the interactive tier; parse only, compile in the background tier | Move the work (Task 5) | The claim narrows to "parsed, not compiled" |

**Best way.** B now where the project allows it, tested first on the benchmark; C where the project already uses references; D after a conformance pass; E as the fallback that sets the interactive tier. This is a combination plus a narrowed claim.

**How we would know.** The second verification of a project is under a quarter of the first on the 10k-file benchmark.

#### 2.3 Finding the tests that matter

**Today.** `verify/test_discovery.ts` walks the repository on each call, reads each JavaScript or TypeScript file up to 1 MB, extracts imports with regular expressions, builds the reverse import graph again, and stops at 20,000 files with a `truncated` flag.

**What it should do.** Select by change, and keep the selection reliable without scanning.

| Option | Evidence | Weakness |
|---|---|---|
| A. Scan each call (today) | Read | Grows with the repository; silently incomplete above the cap |
| B. Keep the import graph on disk, updated from changed files by content hash | Nx's affected command works from changed files plus a project graph; Cursor detects changes with a hash tree | Regex imports miss dynamic imports; keep the compiler-based graph as a later upgrade |
| C. Dependency distance | Google's testing paper simulated that running only targets within a distance of 10 or 6 saved about 42% or 55% with no missed breakage in their data | Simulation on Google's data; unsafe if the threshold is guessed |
| D. Dynamic dependency tracking per test | Ekstazi: 32% average test-time saving over 615 revisions of 32 projects, 54% for longer suites (primary, academic) | Needs a first full run and instrumentation per language |
| E. Predictive selection from history | Meta: about half the test cost, over 95% of failing tests and over 99.9% of faulty changes caught, using gradient-boosted trees retrained weekly (primary) | Needs large history; the compute cost of the selector was not reported in the part I read |
| F. The test runner's own related-tests option | Exists in common runners (not verified here) | Per-runner behaviour |

**Best way.** B now. D or E in the enterprise profile, where the history exists: E needs data a single developer does not have, which is a real reason the enterprise profile exists. Keep the trust-gate rule that a related test must exist, which is independent of how tests are found. Handle the cap by reporting `truncated` as "tests not selected", never as selected. **A combination reaches the bar**, ordered cheapest first.

**How we would know.** The share of failing tests caught by the selection against a full run, on a corpus; selection time flat across repository sizes.

#### 2.4 Re-running only what failed

**Today.** For Jest, Vitest and Mocha, the quarantine re-run repeats the whole test-file set for each failed test; only `node:test` re-runs by name (`verify/tests.ts`).

**What it should do.** Re-run the failed test file or name. Meta retried up to ten times for flakiness detection, so this path is hot at scale.

**Options.** A. Whole set (today). B. The failed file only. C. The failed test by name where the runner supports it (the three runners have name filters; I did not verify the flags today). D. One batched re-run of all failed tests.

**Best way.** D with B as the fallback. **One concept is enough** for the bar "re-run cost is proportional to failures, not to the set".

**How we would know.** Re-run time for one flaky test in a 500-file suite is close to one file's time.

#### 2.5 The dependents cascade

**Today.** After a contract-changing commit, each dependent is compiled and tested in turn, synchronously, against the real project (`verify/impact.ts`). Dependents' count grows with the project.

**What it should do.** Google's data suggests most dependents far from the change do not break; the cascade should be bounded, run off the interactive path, and run in a copy.

| Option | Evidence | Weakness |
|---|---|---|
| A. All dependents, in line, in the real tree (today) | Read | Slow, and writable by test code on Linux |
| B. Dependents within a distance bound | Google's testing paper (simulation) | The bound needs measuring per project |
| C. The cascade in the background tier, recorded as pending until done | Facebook and Google run heavier analysis after the fast check | The change lands before the cascade finishes, so the state "pending" must be explicit |
| D. Leave it to the merge queue or CI | GitHub's merge queue builds the combined result and removes a failing group | Needs a CI integration |

**Best way.** B and C together, run in a copy like the first verification; D for the enterprise profile. This changes the task under the feasibility rule: **move it and narrow the claim.** The change record says "dependents: pending" and then "verified" or "failed".

**How we would know.** The interactive time of a contract-changing change is the same as a non-contract change; the pending state resolves.

### Task 3. Do not repeat work

Quality bar: the same inputs never run twice, a cache hit is never a stale pass, and cached results cannot be forged by the code under test.

#### 3.1 A result cache keyed by inputs

**Today.** I found no result cache. Every verification runs from scratch.

**What it should do.** Bazel's remote caching documentation describes an action cache keyed by the hash of an action's inputs, with a content-addressable store for outputs, and states that it needs hermetic actions and warns about poisoned caches.

| Option | Evidence | Weakness |
|---|---|---|
| A. No cache (today) | Read | Repeats work, including repair rounds that restore an earlier state |
| B. A local cache of verification results keyed by hash of candidate files, affected files, lockfile, tool versions, config and backend | Bazel documentation | A key that misses an input returns a stale pass |
| C. A shared cache for a team | Bazel remote caching; Cursor reuses index across a team | Poisoning; network; access control |
| D. Cache compile and parse only, not test results | Reduces the hermeticity risk | Saves less |

**Best way.** D first, then B for tests that pass deterministically, never caching a result that involved a flaky or quarantined test; C in the enterprise profile with entries written only by Purix itself after a verification, never by the code under test. The key includes the isolation backend, so a Windows "none" result is never served as a Linux one. **A combination reaches the bar.**

**How we would know.** A changed transitive dependency or lockfile misses; an unchanged repeat hits; a forged entry written from inside the sandbox is rejected.

#### 3.2 The index, built once and updated

**Today.** `manifest/indexer.ts` runs `verifyInSandbox` for every file (a full copy and a whole-project compile each). Measured growth is superlinear (finding 1). The result is one very large manifest row, plus `components.json`.

**What it should do.** Cursor describes a hash tree over files so only changed files are processed, about 3.2 MB of hashes for 50,000 files, embeddings cached by chunk content, and an index reused across a team. It reports its time to first query at the 99th percentile falling from 4.03 hours to 21 seconds (vendor-run, a different kind of index; it shows the structure, not the number for Purix).

| Option | Evidence | Weakness |
|---|---|---|
| A. Verify every file at index time (today) | Read and measured | Cost is 2 to 6 s per file, one whole-project verification each |
| B. Index by parsing and graph only; verify a component on first change | Narrows the claim: "indexed, not verified" | Whether anything relies on the indexer's "pass" is not traced |
| C. One batched verification of the project, once | Linear in the project | Hides which component failed |
| D. A hash tree so only changed files are re-indexed | Cursor | A little more state |
| E. A shared index for a team | Cursor reports 92% clone similarity | Needs a server and access control |

**Best way.** B with D; E in the enterprise profile. The verdict is **the bar costs too much, so the task changes**: adoption stops verifying every file, labels components "adopted, not yet verified", and verifies at first change (narrow the claim, move the work). Before building, trace what reads `verification_status` after indexing.

**How we would know.** Indexing time is linear on the 1k, 10k and 100k benchmark; re-index after one changed file touches one file.

#### 3.3 The lock refresh

**Today.** `refreshLockIfPresent` calls `buildLock`, which reads and hashes every governed file of every component and rewrites `purix.lock.json`, after every landed change.

**What it should do.** Update only the changed components' entries, and rely on `purix check` in CI to recompute everything.

| Option | Evidence | Weakness |
|---|---|---|
| A. Full rebuild (today) | Read | Grows with all governed files, per change |
| B. Update the changed components' entries and keep the rest | My reading of the structure | A stale entry survives until a full check |
| C. B plus a full recompute in CI | `purix check --strict` already does this | CI time |

**Best way.** C. **One concept in combination with the existing check reaches the bar.**

**How we would know.** Lock refresh time is flat across the three benchmark sizes; a hand-edited stale entry is caught by the CI check.

#### 3.4 The hook's manifest read

**Today.** On every write or shell tool call, `readGovernedFromStore` runs `SELECT data FROM manifest` and parses every row, including the large index row, before skipping it (`hooks/run.ts`).

**Measured.** Parse time 3, 47 and 118 ms at 1k, 10k and 50k components in a synthetic table. Real rows are bigger. Node's own start-up was not measured.

| Option | Evidence | Weakness |
|---|---|---|
| A. Parse everything (today) | Read and measured | Grows with components; small at today's sizes |
| B. A small table or file of governed paths, read directly, kept current when the manifest changes | Read of the structure | One more thing to keep in step |
| C. A long-running local process the hook calls | Standard pattern | A daemon to supervise |

**Best way.** B. **One concept is enough.** The bar is my target: hook latency under 100 ms at 50,000 components, which fits Nielsen's 0.1-second limit for feeling instant.

**How we would know.** A measured hook run on a 50,000-component manifest.

### Task 4. Keep model cost predictable

Quality bar: before a change runs, the worst-case number of model calls and the tier used for each is known and shown; no loop can exceed a set number; a team can cap spend.

PURIX-33 covers prompts and routing, so this task covers only the multiplication of calls and the budget around them.

**Today.** A change can use two classify and refine calls, three repair calls and two escalation calls, with one bounded format retry possible on each (about ten in the worst case; my reading). `llm/circuit.ts` opens after five failures for 60 seconds. I did not read `llm/budget.ts` in detail.

**What the sources say.** Anthropic's Claude Code cost page gives about 13 dollars per developer per active day on average, 150 to 250 dollars per developer per month, and under 30 dollars per active day for 90% of users. That is the agent's cost, and Purix's verification calls add to it. The same page lists workspace spend limits and rate-limit recommendations by team size, and says hooks and subagents can take verbose output off the main context. I could not read the prompt-caching page; the multipliers in the second-edition research are carried unverified.

| Option | Evidence | Weakness |
|---|---|---|
| A. Fixed counts (today) | Read | No spend control above one change |
| B. Per-change budget of calls and seconds | SRE advice on bounded retries | Needs the per-call record |
| C. Per-developer and per-team spend caps, synced periodically | ADR-036 already chose periodic budget sync; Claude Code's workspace limits are the pattern | A server component |
| D. Cheaper first, stronger on verifier failure | PURIX-33's cascade | Already in place |

**Best way.** B then C; D stays. **A combination reaches the bar.** C belongs to the enterprise profile.

**How we would know.** The status view shows "up to N calls" before a run; a team cap stops spend at the cap in a test.

### Task 5. Verify in tiers, and say which tier ran

Quality bar: each tier has a time budget and a stated scope; the result names the highest tier that finished; no claim is stronger than the tier that ran.

**What the sources say.**

- **Response time.** Nielsen's limits: about 0.1 seconds feels instant, 1 second keeps the flow of thought, 10 seconds is the limit for attention, and beyond that people need a percent-done indicator and a way to interrupt.
- **Facebook Infer.** Reporting at diff time gave a fix rate above 70%, while the same findings in a batch report were fixed at close to zero. A diff took about 15 to 20 minutes; whole-program mode took over an hour and was too slow. Compositional analysis is naturally incremental (primary, CACM).
- **Google Tricorder.** About 50,000 changes analysed per day, with effective false positives under 10% in code review (primary, CACM).
- **Meta.** About 10 minutes as the diff-time target for selected tests (primary paper).
- **Google testing.** Testing every change individually was unsustainable because the cost grew with the square of the load, so they batched changes into milestones; infrastructure failures delayed feedback by up to 9 hours (primary).
- **Static analysis.** Semgrep's own documentation says diff-aware scans do not do cross-file analysis and recommends full scans on trunk daily or weekly; CodeQL's overlay analysis uses a cached base database plus changed files, "up to 10x" faster by its own documentation, and falls back to a full scan on a cache miss.
- **Merge queues.** GitHub's merge queue builds queued changes together on temporary branches with a build concurrency of 1 to 100, removes a failing group and rebuilds the rest.

| Option | Evidence | Weakness |
|---|---|---|
| A. One tier, everything in line (today) | Read | Cannot meet any interactive budget; unusable at scale |
| B. Fast checks only | Nielsen; Tricorder | Weaker claim |
| C. Two tiers: fast in line, full in the background | Infer; Tricorder | The "pending" state must be handled |
| D. Four tiers with a merge-time gate | Google, Meta, GitHub | More states to show |

**Best way.** D. The tiers, as one model:

| Tier | What runs | Time budget | Where |
|---|---|---|---|
| T0 | The hook's governed-path lookup and text rules | Under 100 ms (my target, from Nielsen) | Local |
| T1 | Secret scan, security gate, parse check, cache lookup | Under 2 s (ADR-002's own P95 target) | Local |
| T2 | Affected-only copy or overlay, incremental compile, selected tests | Under 10 s with progress (Nielsen) | Local |
| T3 | Dependents cascade, full affected tests, heavier analysis | Minutes (Meta about 10 minutes; Infer 15 to 20) | Local background, or remote worker in the enterprise profile |
| T4 | Merge queue run, `purix check --strict`, scheduled full scans | Minutes to hours | CI |

T0 and T1 together are the interactive gate. ADR-002's "P95 under 2 seconds" is achievable for T1 and not for the current whole verification; section 8 says what changes. This task ends in: **the bar costs too much in one tier, so the task changes** by moving work down the tiers and narrowing the claim at each one ("checked at T2; T3 pending").

**How we would know.** P50 and P95 per tier on the benchmark sizes; the trust gate's decision shows the tier.

### Task 6. Work correctly with many people and many agents

Quality bar: two changes on one checkout never overlap in the write window; two developers changing different components never conflict on shared files; the number of agents in one repository can be bounded.

#### 6.1 The repository lock

**Today.** The lock is taken at the start of every mutating command (`cli/src/cli.ts`, before the action) and released after. A timer refreshes it every 10 seconds and a lock is called abandoned after 30 seconds (`state/repo_lock.ts`). Verification blocks the thread, so the timer cannot run (measured, finding 4).

| Option | Evidence | Weakness |
|---|---|---|
| A. Timer on the main thread (today) | Measured to fail past about 30 s | Exclusion is lost exactly when work is slow |
| B. Raise the stale time above the longest deadline | Follows from Task 1 | A crashed holder blocks others for longer |
| C. Refresh from a separate worker thread | The block affects only the main thread | A small addition |
| D. Async execution so the timer runs | Comes with Task 1 option C | The larger change |

**Best way.** C now, D with Task 1, and B so that the stale time always exceeds the total change budget. **A combination reaches the bar.**

**How we would know.** The 42-second test: the second process is refused throughout.

#### 6.2 Many developers

**Today.** The lock is per checkout, so 100 developers on separate clones do not wait for each other. The shared points are the committed `purix.lock.json`, one file that every landed change rewrites, and the manifest state. I did not test two branches changing different components; my expectation is that the lock file is a merge hotspot (inference).

| Option | Evidence | Weakness |
|---|---|---|
| A. One committed lock file (today) | Read | Likely conflicts |
| B. Regenerate the lock in CI or a merge queue instead of by hand | GitHub merge queue builds the combined state | The lock in a branch can be stale until then |
| C. A directory of small per-component lock files | Git merges separate files without conflict | A format change; many files |
| D. A merge driver that regenerates the file | Git supports merge drivers (not read today) | A tool each developer must install |

**Best way.** B, with C if a test with two branches shows conflicts. This is a decision to test before building. **The verdict waits on one experiment; the current evidence supports B.**

#### 6.3 Many agents in one repository

**Today.** IDEA-073 proposes bounded parallel streams with a git worktree each. Nothing in the code limits concurrent agents.

**What the sources say.** The SRE book's guidance is load shedding and capping any one client at a share of capacity (it gives 25% of threads), and keeping queues small.

**Best way.** A fixed maximum number of concurrent verifications per machine, a queue behind it, and a worktree per stream as IDEA-073 proposes. **One concept in combination is enough.** Not built.

### Task 7. Keep the person informed about waiting

Quality bar: any step expected to exceed about 10 seconds shows progress and can be cancelled; any timeout or limit says so in words; any result says which tier ran and what did not.

**What the sources say.** Nielsen as above. PURIX-33 chose "checked, but not tested" wording; that wording is the model.

**Today.** `isolation` is carried with the result. There is no tier label and no estimate. Output goes to the terminal; over MCP the agent sees the result after the whole run.

**Best way.** A tier label on every result, an estimate from recorded P95 times, partial results as each tier finishes, and a cancel path that kills the process tree (Task 1). **One concept is enough** per surface. Not built.

**How we would know.** A usability check: a 60-second verification shows progress at 10 seconds.

### Task 8. Measure the cost, in the product and in the build

Quality bar: every tier has a measured P50 and P95 on at least three repository sizes, and a regression stops the build.

**Today.** ADR-002's P95 target is not measured anywhere I could find. PURIX-15 says performance on large repositories "not yet run", and PURIX-19 step 4 says to measure time on a large repo. My benchmark scripts are a seed.

**Best way.** A synthetic generator at 1k, 10k and 100k files (the one I used, extended with realistic file sizes and imports), plus two public large TypeScript projects as real corpora (VS Code and the TypeScript compiler are the ones the sources already cite; I did not run them), and one design-partner repository when there is one. Timings per tier go into the call record and the event log, and CI fails on a regression of a set percentage. Meta's and Google's papers both show that cost grows with load, so measure again when the number of developers grows, not only the files.

**How we would know.** The CI job exists and has failed at least once on a planted regression.

## 5. How the picks fit together: the cost-management model

One change, from the agent's write to the merge:

1. **T0, at the hook.** A governed-path lookup from a small table. The hook has a deadline, so it never hangs an agent.
2. **T1, at the gate.** Secret scan, security gate, parse check, and a cache lookup keyed by the inputs. A hit returns the earlier result with the label "cached". Cost follows the change.
3. **T2, in line.** Affected-only copy or overlay, incremental compile, selected tests, all under per-step deadlines and an output cap, with progress shown past 10 seconds. A pass here is "verified at T2".
4. **Repair, only for code failures.** Infrastructure results never enter it. It stops at the change budget (calls and seconds), early stop on.
5. **Write and commit.** The write path is unchanged. The lock refresh updates only the changed entries.
6. **T3, in the background.** Dependents within a distance bound, full affected tests, and heavier analysis, in a copy. The change record says "pending" until they finish. In the enterprise profile this runs on a remote worker against a shared cache.
7. **T4, at merge.** A merge queue runs `purix check --strict` on the combined result and regenerates the lock; full scans run on a schedule.

What each cost does under this model: time per change follows the size of the change and its affected set; disk follows the changed files; CPU follows the selected tests; memory is capped; network is used only by the cache, the registry check and the models; model tokens are bounded per change and per team; the complications (flaky tests, no network, Windows without a boundary, a stale lock) become labelled results instead of silent failures.

The same model runs for a single developer with everything local and T4 absent, and for a company with remote workers and a shared cache. That is why section 6 recommends one codebase.

## 6. One codebase or two editions

**Verdict: one codebase, configured.** The evidence:

- **The costs differ in degree, not in kind.** Every fix above (deadlines, affected-only work, caches, tiers) helps a single developer too, because a single developer also has a repository that grows. Nothing in the problem list needs a different engine for a large company.
- **GitLab measured what two repositories cost.** GitLab kept its community and enterprise editions in two repositories, then merged them. A single security release needed about 150 merge requests across the two repositories, roughly halved by one. The migration took 55 engineers, over 600 merge requests and about 1.5 million changed lines (GitLab's own account, 2019). Enterprise code now lives in an `ee` directory and is loaded as modules. Purix has one developer; two copies would double every fix.
- **What differs is a feature, not a fork.** Remote verification workers, a shared result cache, a shared team index, team spend caps, a merge-queue integration, and retention controls are additions around the same pipeline. They can sit in a separate directory, as GitLab's do, and be gated by tier on the server, which matches the open-core structure already recorded for Purix.
- **A configuration profile holds the rest.** A scale profile sets where T3 runs (local background or remote), where the cache lives (local or shared), the test-selection method (graph, or history-based where data exists), and the default budgets.

**When two editions would be justified.** If a legal or customer requirement said enterprise source must not ship in the individual package, directory separation handles it at packaging time without a second repository. If the enterprise product became a hosted service with a different runtime architecture, the question should be asked again. Neither is the case in the evidence I have.

**ADRs the person should ratify:**

- **ADR-002.** Amend the main text so the copy is affected-only or overlay by platform (section 4, concept 2.1); restate the pre-commit latency target as T1 under 2 seconds with T2 and T3 budgets, since the whole verification cannot meet 2 seconds; keep the 2 GB ceiling as provisional and implement it.
- **ADR-036.** Confirm that team spend caps sync periodically and belong to the enterprise profile.
- **ADR-064.** Record the hook latency target (under 100 ms at 50,000 components).
- **ADR-067.** Running git per component is likely slow on large repositories and was not measured; the Scalar evidence (sparse checkout, fsmonitor, commit-graph, background maintenance; `git status` on a large repository from 12.2 to 1.5 seconds with fsmonitor) argues for a bounded use of git and for running it once per change, not per component. I did not measure Purix's git calls.
- **A new decision:** adoption marks components "adopted, not yet verified" (concept 3.2).

## 7. What this means for the other domains

For each remaining domain, the research must now fill in the cost and scale fields and test its options against the large-repository bar. The handoff is updated with a new rule and seeds. The two decisions with the largest reach are the tiers (Task 5) and the cache (Task 3.1), because every later domain's cost lands in one of the tiers.

## 8. What this document did not settle

- **Real large repositories.** Everything about 1M lines is extrapolated. A pilot on public large projects, then one design partner's, comes first.
- **Windows and macOS costs.** The copy, the process start and the hook cost on Windows are unmeasured, and Windows is a supported platform with no isolation today.
- **Whether a TypeScript incremental build file is reusable inside the copy**, and whether TypeScript 7's build mode works for Purix.
- **Merge behaviour of the committed lock** with two or more developers.
- **What relies on the indexer's pass status**, before concept 3.2 is changed.
- **The memory ceiling mechanism** on each platform, beyond ADR-002's list.
- **The language mix of large companies**, and the build costs for Java, C# and Go.
- **Prompt caching** and the real token cost per change; `llm/budget.ts` and the call record were not read in detail.
- **Server cost and design** of a shared cache and shared index: access control, poisoning defences, storage. Bazel's documentation names the poisoning risk and does not settle it for Purix.
- **Hook start-up time** and the full hook cost on a large manifest.

## 9. Corrections to `PURIX-RESEARCH-00` and `PURIX-RESEARCH-01`

I checked both documents against the code. Where a statement was wrong or incomplete, it is corrected here and in the two files (each now begins with a short list of corrections).

**RESEARCH-01 corrections**

1. **Concept 6.1 says the real project is safe "because of the write path, not because of the sandbox".** That holds for the first verification, whose candidate content is written from memory. It does not hold for the dependents cascade, which compiles and tests each dependent with the real project as working and writable folder (`verify/impact.ts` line 53; `verify/tests.ts` lines 228 and 276). On Linux with bubblewrap, that folder is bound writable. This is read from the code; I could not run bubblewrap here. Best way: the cascade runs in a copy or overlay like the first verification.
2. **Section 1 says ADR-002 was read "in full except its amendment log".** I have now read the log. Its 2026-08-05 entries set a provisional 2 GB memory ceiling per subprocess and a pre-commit latency target of P95 under 2 seconds. The code enforces neither. This adds to finding 1.
3. **Concept 3.1 and finding 3 (no time limit).** Confirmed by experiment: a never-ending child did not return in 15 seconds.
4. **Concept 3.2 says "I did not check what `maxBuffer` the process wrapper uses".** The wrapper sets none, so Node's default of 1 MiB applies. Measured: above that the call returns an error with the output dropped, and `verify/tests.ts` reports a failure.
5. **Concept 8.2 says on Windows `which` does not exist, so detection fails and falls to unisolated without saying why.** The code checks the platform first (`process.platform === "linux"` and `"darwin"`), so `hasBinary` is never called on Windows. `verify/tests.ts` also prints a warning that names WSL2. The silence claim is wrong; the "no boundary on Windows" claim stands.
6. **Concept 8.1 says "about 56 test cases across nine files".** I count 45 declarations with a line-start pattern across the nine files; other counting methods may give more. The finding that no test runs a hostile program against the real boundary stands.
7. **Compile step and TypeScript 7.** TypeScript's native compiler was released on 2026-08-03 (secondary report). It changes the cost side of concept 2.4 and needs a conformance run.

**RESEARCH-00 corrections**

1. **Section 5 item 2 (no time limit) is confirmed**, and extended with the output cap and memory finding above.
2. **Section 5 item 6 says I did not trace whether the repository lock covers the write window.** Traced: the lock is taken at the start of every mutating command and released after, so it covers the window in principle, but its refresh timer cannot run during synchronous verification, and a second process took it at about 38 seconds in my test. I did not find a second drift check right before the write, so the unprotected window equals the verification time (an inference from not finding one).
3. **Stage 4 says everything else is copied.** That includes build output (`dist`, `build`, `.next`, `target`), which is large in real projects.
4. **Section 6 (not yet read).** Now read: `state/repo_lock.ts`, `state/drift.ts`, `manifest/store.ts`, most of `manifest/indexer.ts`. Still unread: `state/reconcile.ts` in detail, `tools/broker.ts`, `llm/classify.ts`.
5. **Stages 4 to 7 add a cost reading.** The cost of the stages is in section 2 of this document.

**Confirmed against the code, no change:** the 17 typosquat names; three repair rounds and two escalation attempts; the Claude hook matcher without a timeout; the TypeScript compile step always labelled "no isolation" and carried up by the provider; the trust-gate rule at `gates/trustgate.ts` line 82; macOS and Windows branches as described.

## 10. Sources

**Primary**

- Meta, "Predictive Test Selection", arXiv 1810.05286 (excerpt; about half the test cost, over 95% of failing tests, over 99.9% of faulty changes; weekly retraining; retries up to 10).
- Google, "Taming Google-scale continuous testing", ICSE-SEIP 2017 (excerpt; 150 million test runs a day; 2.07% of targets both pass and fail; quadratic cost; batching; dependency-distance simulation).
- Facebook, "Scaling static analyses at Facebook", CACM 2019 (excerpt; diff-time fix rate over 70%; 15 to 20 minutes; whole-program over an hour).
- Google, "Lessons from building static analysis tools at Google" (Tricorder), CACM 2018 (excerpt; under 10% effective false positives; about 50,000 changes a day).
- Google, mutation testing at scale, arXiv 2102.11378 (excerpt).
- Gopinath and others, Ekstazi, regression test selection (abstract; 32% average, 54% for longer suites).
- Bazel documentation: sandboxing; remote caching (read).
- Nx documentation: affected commands (read).
- TypeScript Handbook: project references; TypeScript 3.4 release notes (vendor-run figures for `--incremental`).
- GitHub CodeQL documentation: diff-informed and overlay analysis; Semgrep documentation: diff-aware scanning (read).
- GitHub documentation: merge queue (read).
- Google SRE book, "Addressing Cascading Failures" (read).
- Bubblewrap manual page (read).
- Anthropic, Claude Code "Manage costs" (code.claude.com; read).
- Nielsen Norman Group, "Response times: the three important limits" (read).
- GitLab, "Why we're moving to a single codebase for GitLab Community and Enterprise Edition", 2019 (the company's own account of its own project).
- Microsoft, Scalar and sparse checkout announcement (vendor-run: `git status` 12.2 to 1.5 seconds with fsmonitor); Windows Dev Drive announcement (vendor-run: up to 30% faster builds in Microsoft's own synthetic test).
- Uber Engineering, "Slashing CI costs" (vendor-run: 53% lower CI resource use and 37% lower wait times over 21 weeks; speculative-build pruning; it does not cover test selection or caching).
- Cursor, secure codebase indexing (vendor-run: hash tree, 3.2 MB for 50,000 files, time to first query 4.03 hours to 21 seconds, 92% clone similarity).
- Vitest documentation: default test timeout of 5,000 ms.
- Purix source code, `PURIX-RESEARCH-00`, `PURIX-RESEARCH-01`, `PURIX-33`, the vault (ADR-002 with amendments, ADR-036, ADR-064, ADR-067, PURIX-15, PURIX-19, IDEA-073).
- My own experiments, described in section 1.

**Secondary (used only to point at things to verify)**

- InfoQ report on the TypeScript 7 native compiler release, 2026-08-03 (8 to 12 times faster full builds; no information on incremental or build mode).
- The second-edition AI research, for the prompt-caching figures and the approval acceptance figure, which I could not re-open.
- Google, "Developer Productivity for Humans, Part 4": abstract only; I took no numbers from it.

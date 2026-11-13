# Domain research 07: self-healing and repair

## Verification update, 2026-10-31 (method v2)

**Status under method v2: Settled with gaps.** Pins: code `packages__2_.zip` d873c00c78b6822c; vault `purix-knowledge-working-2026-10-04.zip` 483002fb893b0085 (declared current by the owner on 2026-10-31, refresh after domain 16); Linux, Node 22.22.2; one run each. Full detail: `PURIX-RESEARCH-VERIFICATION-04-07-2026-10-31.md`. Probes: `research-verify-experiments/`. No finding below was deleted.

**Re-run results.** Finding 1: confirmed by reading `recovery/resolve_verification.ts` (stops only for `fail` with `policyBlock`; `not_installed` and timeout fall through to `runSelfHealingLoop`); the stubbed call counts were not re-run. Finding 2: confirmed by probe, with a correction (below). Findings 3 to 8: not re-run (3 and 4 are literature, 5 is read from constants, 6 needs a stubbed run, 7 is an inference from 05-1 and is exactly as strong as 05-1, 8 is open by its own statement).

**Correction applied to finding 2.** The text said the lock accepts `*_test.*`. In `verify/test_discovery.ts` (`isTestPath`) the `*_test` and `test-*` names, and the `test/` and `__tests__/` folders, count only for JS and TS files. Probe on 12 paths: locked are `a.test.ts`, `src/__tests__/a.ts`, `test/setup.ts`, `src/foo.spec.ts`. Not locked: `tests/test_m.py`, `test_m.py`, `m_test.py`, `tests/conftest.py`, `vitest.config.ts`, `jest.config.js`, `src/__snapshots__/a.snap`, `pytest.ini`. The folder `tests/` (plural) is not matched. The Python recogniser returns true for the three Python test files and `conftest.py`. The finding is slightly worse than written: config and snapshot files are unprotected in every language. The code comment says the integrity check and the lock share one rule, so one fix covers both.

**Number.** 07 is confirmed as the number for this domain.

Prepared 2026-10-29. This document replaces `PURIX-RESEARCH-07-SELF-HEALING-AND-REPAIR-PROTOCOL-2026-10-29.md`, which was only a protocol and a code read and was not research. The number 07 is proposed by me and not yet confirmed in the plan (rule C). The document covers what Purix does today when a verified change fails, what published research says about repair, what the experiments showed, and the best way for each task. Status: **settled with gaps** (section 5 lists them and the cost to close each).

## Gate table (rule A)

| Gate | State |
|---|---|
| 0 Snapshot pinned | Done. Code d873c00c78b6822c, vault 483002fb893b0085 (2026-10-04, nine days older than the code), research set 5195467e53521533. Vault not re-checked for ADR-002, 008, 010, 012, 051, 059 bodies |
| 1 Protocol before searching | Done in the earlier protocol file; the tasks and experiments there are carried into section 3 and the appendix |
| 2 Sources with read depth | Done, section 6. Only one source read in full |
| 3 Claims register | Delivered as `research-07-experiments/claims-07.json` (14 claims) in the same shape as the other registers; not yet checked by `scripts/check-claims.mjs` |
| 4 Run what picks name | Partly. E1 to E3 run against the code. No model run (E4 to E6 not run) |
| 5 Measure properly | Not met. Each experiment ran once; the model was a stub |
| 6 Try to break the findings | Partly. Two of my own first findings were broken by running them (finding 2 and 3 of the old file) |
| Rule B (re-run by another session) | Not done |

## 0. Read this first

**What this domain is for.** When the sandbox verifier rejects a change, decide whether a model should be asked to fix it, how many times, with what information, and under what limits, and make sure a fix cannot pass by weakening the checks it is being judged by.

**Findings, most important first.**

1. **A missing tool or a timeout is sent to the repair loop as if it were a code error.** `resolveVerification` stops only for a policy block. A `not_installed` result (pyright absent) produced 7 stubbed model calls; a repeated timeout produced 3 repair calls and 3 full verifications (E1, run once, stubbed model). Consequence: money and minutes are spent on failures no edit can fix, against handoff rule 6.3 item 7.
2. **The rule that stops repair from editing tests knows only JavaScript and TypeScript names.** The lock in `verify/compile.ts` uses `isTestFilePath`, which accepts `*.test.*` and `*.spec.*` (JS and TS), `*_test.*` and `test-*` names (JS and TS extensions only), and files under `test/` or `__tests__/` (JS and TS only; corrected 2026-10-31). A repair rewrote a Python assertion (`tests/test_m.py`) and emptied a Vitest include list, and both passed (E2d, run once). The Python provider already has its own recogniser, `isPythonTestFilePath` (`verify/python_test_integrity.ts`), and the lock does not use it. Consequence: on Python the lock protects nothing, and on TypeScript it misses configs, snapshots, setup files and a `tests/` folder.
3. **Published evidence does not support a long repair loop.** In the one controlled study I read in full, repair beat drawing more fresh samples only slightly or not at all once cost was counted, and extra repair attempts on one candidate paid least. Consequence: Purix's 3 rounds plus 2 escalation rounds have no source behind them. The setting differs from Purix (old models, self-contained puzzles), so this is a direction, not a number.
4. **Repair works when the feedback is reliable, which is what Purix's verifier is.** Two surveys and one paper say correction succeeds with trustworthy external signals and fails without them. Consequence: the quality of the repair loop is capped by the quality of the tests, so document 06's findings (a pass can mean nothing ran; one re-run forgives a flaky failure) apply to every repair round.
5. **One failing change can cost up to 6 whole-project verifications and 6 to 7 model calls** (read from constants in `heal.ts`, `escalate.ts`, `classify_and_compile.ts`). At document 02's per-file costs this is the largest single cost multiplier for a large repository.
6. **The oscillation guard almost never fires.** A repeating pattern A, B, A went uncaught; a re-sent no-change edit was caught only on round 3; in escalation it cannot fire (E3, run once).
7. **Escalation's neighbour context is probably empty for adopted components.** `gatherNeighborContext` (`recovery/escalate.ts`) reads `depends_on` and `depended_on_by`; document 05 found these empty for everything the indexer and adopt produce. This is an inference from two documents, not a run.
8. **Who should repair is undecided by the evidence.** Purix sits above a coding agent that already holds the task and the conversation. Returning a shaped failure to that agent may repair at lower cost than a second model inside Purix. No source I read tests this arrangement. Experiment E4 would.

**What is already good and should not be touched.** Repair runs against a copy; real files are not touched until a pass (`heal.ts` comment, read). Failure text is shaped before the model sees it and every piece passes the input scan. The ledger carries no compiler output, so a hostile error message cannot ride into the next prompt. A policy block stops the loop with no model call. A cached library fix is replayed and re-verified before use. Repair edits to recognised test files are rejected outright (E2a to E2c, confirmed).

## 1. How I worked, and what I could not check

**Read in the code:** `recovery/resolve_verification.ts`, `heal.ts`, `heal_config.ts`, `escalate.ts`, `oscillation_guard.ts`, `repair_ledger.ts`, `classify_and_compile.ts`; `sandbox/sandbox.ts` lines 180 to 275; `verify/verify.ts` (the result type); `verify/failure_shape.ts` (header only); `classifyRepair` in `llm/classify.ts`; `verify/compile.ts` (the lock and `applyEdits`); `verify/test_discovery.ts` (`isTestPath`); `verify/python_test_integrity.ts` (one line); callers of `resolveVerification`. Vault: ADR-051, first 60 lines.

**Ran:** the project's own `heal.test.ts` (8 of 8 passed) and my experiments `exp07.test.ts` and `probe_is_test_path.ts`, on Linux, Node 22, one run each, model call stubbed.

**Not done or not verified:**
- No real model was called, so no rate of "repair rescues a failure" exists in this document. Experiments E4 to E6 are not run.
- I read none of the tests in `recovery/` and not `llm/escalate.ts`, the repair prompt, the router, or most of `failure_shape.ts`.
- ADR-002, 008, 010, 012 and 059 bodies not read. ADR-051 first 60 lines only.
- Of the sources, only Olausson and others was read in full; the rest are abstracts, excerpts or secondary summaries (section 6).
- I did not read how Claude Code, Codex or OpenHands handle failed edits, nor any large-company repair report (Google, Meta). That is a real gap for a product aimed at large companies.
- Java, C# and Go were not examined; the only providers read are TypeScript and Python.
- Windows and macOS: nothing run.

## 2. What the domain is, today, in one paragraph

A failing change reaches `resolveVerification` from four call sites. A pass returns. A policy block stops. Anything else enters `runSelfHealingLoop`, up to 3 rounds: shape the failure, call a low-tier model for edits, apply them (the test lock lives here), check the oscillation guard, run a whole verification. If all fail, `runEscalation`: look up the operation library, gather neighbour files, scrub secrets, scan for injected instructions, then up to 2 rounds with a high-tier model. Before all of this, `classifyAndCompile` makes one extra cheap call when the first edits do not apply. Early stop on a repeated failure exists and is off by default.

## 3. The tasks and their concepts

Tasks 1 to 5 below replace the earlier list of eleven; tasks 7 to 10 of that list (apply, escalation, giving up, cost) became concepts here.

### Task 1. Decide whether a failure is for the repair loop

#### 1.1 A result kind set where the failure happens

**Today.** `VerificationResult` has `pass`, `fail` (with an optional `policyBlock`) and `not_installed` (`verify/verify.ts`). `resolveVerification` treats everything except a policy block as repairable. `failure_shape.ts` has a `timeout` class but only for labelling the prompt. E1 measured the cost (appendix).

**What it should do.** Every non-pass result carries a kind: code, policy, environment (tool missing, sandbox could not start), or resource (timeout, output limit). Only code failures reach a model. Document 06 and handoff rule 6.3 item 7 require this. The SRE guidance I read through secondary summaries says the same for service retries: classify failures, do not retry permanent ones, cap attempts per request at three.

**Quality bar.** Zero model calls for any result whose kind is not code; each such result is reported with its own words and a next step (the `actionHint` field already exists for `not_installed`). Measured by E1.

**Cost and scale.** Saves up to 5 model calls and 5 whole-project verifications per affected change (read). The affected share rises where workers are remote or shared, because tool and resource failures are more common (expected, not measured).

**Large-repo bar.** The same, plus a resource failure must not be retried on the same worker without a different limit or a different tier.

| Option | Evidence | Weakness |
|---|---|---|
| Today: policy block only | Code read; E1 shows the loop runs | Spends calls on unfixable failures |
| Kind field set at the source (spawn timeout, output limit, tool missing, sandbox start failure) | Design; the fields exist in part (`not_installed`, `policyBlock`) | Every verifier and provider must set it; a timeout can also be a real infinite loop in the new code |
| Guess the kind from the message text | `failure_shape.ts` already does this for the label | Text changes between tool versions; a hostile or odd message can mislead it |
| Re-run the original code to see whether it also fails | Document 06 proposes a baseline compare | One more run per ambiguous case |

**Combination.** Kind at the source, plus the baseline re-run only for timeouts and output-limit results, which are the ambiguous ones. Text guessing is left out because it is the weakest option and the source-set kind makes it unnecessary.

**Best way.** The combination. Evidence level D (our reasoning, with the E1 measurement showing the problem and the SRE guidance as secondary support): not yet shown to improve results; E1 with the fix must show zero calls. **Case: a combination reaches the bar.**

**How we would know.** Rerun E1 after the change: zero model calls for not-installed and timeout. Add a probe where the new code has a real infinite loop: it must still be reported as a code failure, not as an infrastructure one.

### Task 2. Decide who repairs, and how many tries

#### 2.1 Where repair runs

**Today.** Purix repairs inside itself: three cheap rounds, then two strong rounds, for changes that came from the instruction path and the diff path alike (`resolve_verification.ts`).

**What it should do.** Be supported by evidence. The evidence I read says: repair works when the feedback is reliable (Kamoi and others, survey of self-correction, abstract read); a model correcting itself without outside signals is unreliable and sometimes worse (Huang and others, abstract and summary read, about reasoning tasks); with test feedback, self-debugging gains up to 12 points on code benchmarks and can match baselines that draw more than ten times as many candidates (Chen and others, abstract read, authors from Google); and in the one study at equal cost, repair gave modest or no gain over drawing fresh samples (Olausson and others, read in full). Those sources disagree on size, not on direction, and none used repository-level changes.

**Quality bar.** At the same model spend, the arrangement must fix at least as many failing changes as the alternatives and must not lower the share of correct changes (measured by E4). I propose a margin of 5 points; this is my number.

**Cost and scale.** Each repair round costs one model call and one whole-project verification. The model cost is small next to the verification at large sizes (read for the structure, from document 02 for the scale; the multiplier is read, not measured).

**Large-repo bar.** A failing change must be repaired or handed back within a bounded time that fits the interactive tier of document 02 (under about 10 seconds for the gate, background beyond). The number of rounds the tier allows is set by the verification time, not by a constant.

| Option | Evidence | Weakness |
|---|---|---|
| A. Today: repair loop inside Purix (3 + 2) | Code read | No source supports the round counts; costs up to 6 verifications |
| B. Return the shaped failure to the host agent and let it repair | Reasoning: the agent holds the task, files and conversation; Kamoi: reliable external feedback is what makes correction work, and Purix supplies it | Needs an agent on the other end; the MCP diff path and CI may have none; the agent may also weaken tests, so the lock must move to the check at the door |
| C. Fresh candidate instead of repair | Olausson: more initial samples gave the more reliable gains | Equal or higher cost; on the diff path Purix did not write the candidate and cannot resample it |
| D. Two-stage: strong model writes the diagnosis, cheap model writes the patch | Olausson: replacing weak feedback with a stronger model's beat both baseline and plain repair at all budgets (old models, Python puzzles) | One more call per round; not tested on repository-level changes |
| E. Deterministic fixes first (formatter, lint autofix, unused imports), then one model round | Aider's documentation says it lints and fixes automatically and the lint command is user-chosen (excerpt read) | I did not read the TypeScript or Python tools' own fix capabilities; covers only a narrow class |

**Combination.** No single option reaches the bar for every path. Instruction path (Purix made the candidate): E, then one round of A or D, then hand back. Diff path and MCP path (a host agent made the candidate): B, with Purix's own model not called. This makes repair a feature of where the candidate came from, which is how the existing two paths already differ (`classifyDiff` is already a separate call on the diff path).

**Best way.** The staged answer above. Evidence level C to D: not yet shown to improve results. The experiment is E4 (below). **Case: the bar costs too much, so the task changes: move it.** Repair moves to the host agent where one exists, and Purix keeps a small repair for the path where it wrote the candidate. This may amend ADR-002 (sandbox mechanism for self-healing and escalation); I did not read its body, so the person should check before ratifying.

**How we would know.** E4 on 100 failing changes: share fixed at round 1, 2, 3 and by escalation, cost per fixed change, and the same for arrangement B with a stub agent. Keep a round only if it fixes at least 10% of the changes that reach it (my number).

#### 2.2 Round budget and stop rules

**Today.** `MAX_ATTEMPTS = 3` and `ESCALATION_MAX_ATTEMPTS = 2`, fixed (`heal.ts`, `escalate.ts`). Early stop on the same failure class at the same line exists and is off (`heal_config.ts`); it needs a named location on both failures. The oscillation guard has threshold 3 (`oscillation_guard.ts`).

**What it should do.** Spend rounds where they pay. Olausson and others found that, at fixed cost, adding more repair attempts to the same candidate gave marginal gains and sometimes lower results at small budgets, while more diverse first attempts gave steadier gains. The Google SRE guidance, read through secondary summaries, caps attempts per request at three and adds a budget across requests (about 10%); the primary chapter was not opened.

**Quality bar.** No round runs that the evidence says is unlikely to help (a repeat of the same failure at the same place; a state seen before), and total repair spend per change and per day is bounded in tokens and in time.

**Cost and scale.** Today's worst case is 6 verifications and 6 to 7 model calls per failing change (read). A fixed cap does not shrink when verification gets slower, which is what happens in a large repository (expected).

**Large-repo bar.** The budget is in wall-clock and tokens, so a repository whose verification takes a minute gets fewer rounds than one that takes a second.

| Option | Evidence | Weakness |
|---|---|---|
| A. Today: fixed 3 + 2 | Code read | Unmeasured; ignores verification cost |
| B. Fixed 1 + 1 | Olausson: extra repairs per candidate pay least | Direction only; the number is my guess |
| C. Budget in tokens and time per change and per day, with a per-change attempt cap | SRE guidance (secondary); LLM-agent write-ups describe the same ledger idea (secondary, not used as evidence) | Needs a place to keep the day total (the usage ledger exists; I did not read it) |
| D. Early stop on repeated failure identity (exists, off) | Code read; PURIX-33 says it waits for call data | Needs a named line on both failures; a shifted line number defeats it (the code says so) |
| E. Guard on repeated or reverted states, seeded with the failing state | E3 shows today's guard misses A, B, A | Untested design |

**Combination.** C as the outer limit, D inside it once E5 shows it does not cost fixes, and E replacing the current guard. B is what C produces when verification is slow.

**Best way.** The combination. Evidence B for the direction (peer-reviewed, independent, old models) and D for every number: not yet shown to improve results; E4 and E5 raise it. **Case: a combination reaches the bar.**

**How we would know.** E4 and E5. E3 rerun: A, B, A must stop before the next verification.

### Task 3. Decide what the repair model sees

#### 3.1 The failure text and the ledger

**Today.** `shapeFailure` limits tsc output to 8 errors from touched files, with code around the first 3, and a count of the rest; pytest to its failure lines; anything else to the first and last 2,000 characters (header of `failure_shape.ts` read; body not read). The ledger holds one 160-character line per round (`repair_ledger.ts`). Both pass `sanitizeAndRecord`.

**What it should do.** Give the model the failing check's own output in a form it can act on. Olausson and others found the model's explanation of why code failed was the bottleneck: GPT-4's explanations were judged wrong in 32 of 80 cases against 7 of 80 for human ones, and repair success rose from 33.3% to 52.6% with human explanations (full text read; 40 programs, 16 participants, introductory-heavy sample).

**Quality bar.** Every supported runner has a shaper that keeps the failing location and message and drops the rest. Measured by a fixture per runner.

**Cost and scale.** Shaping is cheap (read). Prompt size is bounded at about 4,400 characters. Cost does not grow with repository size.

**Large-repo bar.** The failing test's name and location survive shaping even when the run reports thousands of lines.

| Option | Evidence | Weakness |
|---|---|---|
| A. Today: shapers for tsc and pytest, fallback for the rest | Code read | Jest, Vitest, Mocha, node:test and every other language get head and tail text |
| B. Add shapers for the four JS runners and for Go, Java, C# output | Design | One shaper per tool and version |
| C. Ask the runner for structured output (JSON or JUnit XML) | Runner documentation (not read here) | Different per runner; I did not check each |
| D. Strong model writes the diagnosis first | Olausson: stronger feedback unlocked gains (B) | Extra call; unproven on repository changes |

**Best way.** B now, C where the runner supports it, D only if E4 shows a lift. Evidence C for B and C, B for D's direction. **Case: one concept is enough for now (B), with C as the way to reach other languages.** Not yet shown to improve results.

**How we would know.** A fixture per runner: failing output in, shaped text out, the failing location present. E4 with and without D.

#### 3.2 Context beyond the failing file

**Today.** Repair shows the failing component (whole, or windows around the named lines when large). Escalation adds neighbour files within a token cap (`gatherNeighborContext`). The neighbours come from `depends_on` and `depended_on_by`.

**What it should do.** Show the code the failure depends on. Document 05 found those two fields empty for every component the indexer or adopt creates, so escalation's neighbour block is probably empty for them (inference from two documents, not run). Fixing the edges belongs to document 05.

**Quality bar.** For a failure caused by a changed function in another file, that file is in the prompt.

**Cost and scale.** Bounded by the neighbour token cap. Building edges at call time costs a parse of the import graph (document 05 measured 0.4 to 1.2 s for 2,000 to 3,600 files warm).

**Large-repo bar.** The cap still holds, and the files chosen are the ones named in the failure first.

| Option | Evidence | Weakness |
|---|---|---|
| A. Today (stored edges) | Code read | Empty for adopted code (inference) |
| B. Files named in the failure output first, then import neighbours computed on demand | Document 05's parse-only index | Needs document 05's index |

**Best way.** B. Evidence C, from the code and document 05. **Case: one concept is enough.** Test: a failure caused in a neighbour file shows that file in the prompt (stub the model and read the prompt, as `heal.test.ts` does).

### Task 4. Keep repair honest

#### 4.1 What a repair may not edit

**Today.** `applyEdits` rejects any edit to a path that `isTestFilePath` accepts, for repair, escalation and cached replays (`verify/compile.ts`, §E-TESTLOCK). The rule matches JavaScript and TypeScript names only (`verify/test_discovery.ts`).

**What it should do.** A repair may change the code under test and nothing that decides whether the test passes. The ImpossibleBench paper (abstract and secondary summaries read) measured coding agents with test access: they delete or edit failing tests, hard-code results for the tests, and in one case overload operators. It also reports that prompt, test access and the feedback loop change how often this happens. Claude models and Qwen3-Coder mostly edit tests in that benchmark, from a secondary summary only.

**Quality bar.** A planted weakening of any test surface (test files in any language, configs that select or skip tests, snapshots, setup files, fixtures) is rejected in repair and escalation. Measured by the E2 probes extended to these files.

**Cost and scale.** A path check is free. An allowlist (below) needs the failing change's file list, which is already known (`touchedPaths` in `heal.ts`).

**Large-repo bar.** The rule holds with monorepo layouts and nested test folders, so it uses the language provider's recogniser and a configurable list, not one global pattern.

| Option | Evidence | Weakness |
|---|---|---|
| A. Today: JS/TS path pattern | E2a to E2c pass; E2d fails | Python, `tests/`, configs, snapshots, setup unlocked |
| B. Use each language provider's own recogniser | `isPythonTestFilePath` exists and is used by the post-check in `escalate.ts` but not by the lock | Still a name rule |
| C. Add test configs, snapshots, fixtures and setup files | E2d shows the config route works | Needs a per-runner list |
| D. Allowlist: a repair may edit only files the failing change touched plus files the failure names | Reasoning; `touchedPaths` exists | A real fix sometimes needs a new helper file |
| E. Hash the whole test surface before and after, reject on any difference | Reasoning | Needs the test surface defined, which is B and C again |
| F. Run the existing integrity checkers on the repair result and block (today they only stop library promotion) | `escalate.ts` already calls them after a pass | Document 06 measured that these catch few evasions |

**Combination.** No single option reaches the bar. Use D as the outer wall (smallest possible surface), B and C to name the test surface inside it, and F as a blocking check on whatever D allows. D, B and C are cheap and deterministic and come first; F is the backstop.

**Best way.** The combination. Evidence C and D: not yet shown to improve results. E2 rerun with Python, config and snapshot probes must reject all of them; special-casing and operator overloading are not covered by any path rule (see 4.2). **Case: a combination reaches the bar.** A specific consequence for document 06: its integrity-check recall figures bear on option F only.

**How we would know.** The E2d probes rejected; the probe set grows to one case per path class in `probe_is_test_path.ts`.

#### 4.2 Hard-coded results and other shortcuts that no path rule sees

**Today.** Not covered in repair. Document 06 proposes changed-line coverage and a small mutation budget for ordinary changes.

**What it should do.** Not accept a pass that comes from special-casing the test input. ImpossibleBench lists test editing and special-casing as separate behaviours, so a lock on files does not cover the second.

**Quality bar, cost, options.** Not researched in this document. The candidates are a diff check for literals copied from failing-test output, changed-line coverage from document 06, and a mutation budget on the repaired lines.

**Best way.** None picked. **Case: open.** Sources needed: a primary study of reward hacking in repair, and a probe set of special-casing patches. Cost to close: one session.

### Task 5. Cost of the whole loop at scale

#### 5.1 What each round verifies

**Today.** Every round runs a whole-project verification (`verifyInSandbox`; document 02 for its cost). Repair, escalation and the library replay each call it.

**What it should do.** Check the cheapest thing first. The failing check ran last time; rerunning it alone costs a fraction of the whole run. The whole run is needed once, before accepting.

**Quality bar.** Repair rounds on a 10,000-file repository reach "fixed or handed back" within the tier budget. I propose 60 seconds for the whole repair path on 10,000 files, with the single full verification included; this is my number and needs E6.

**Cost and scale.** One whole verification per round today (read). Document 05 measured 2.1 to 2.7 seconds per file for indexing-time verification on a 1 to 2 CPU Linux machine (document 02's earlier figure was withdrawn), and a million-line figure remains an extrapolation. No repair-specific timing was measured here.

**Large-repo bar.** The count of whole verifications in the repair path is one, not up to six.

| Option | Evidence | Weakness |
|---|---|---|
| A. Today: full verification every round | Code read | Up to 6 per failing change |
| B. Rerun the failing check alone each round; full verification once at the end | Design; document 06's affected-test selection | The narrow check can pass while the full run fails (then one more round) |
| C. Run repair and a speculative full verification in parallel | Design | Doubles CPU, which large companies may accept and individuals not |
| D. Move the full verification to the background tier and mark the result "repaired, not yet fully verified" | Document 02's tier model; the "checked, not tested" wording is the model | Narrows the claim; a profile choice, not a default |

**Combination.** B inside the interactive tier, D in company profiles with remote workers.

**Best way.** B first. Evidence D: not yet shown. **Case: the bar costs too much, so the task changes: simplify it** (one full verification, not several). **How we would know.** E6: verification count and wall time per repair path at 1,000, 10,000 and 50,000 files, three repetitions, spread reported.

## 4. How the picks fit together

Order of work, cheapest and most certain first: 1.1 (kinds, stops the waste), 4.1 B and C (widen the lock, small and testable), 2.2 E (fix the guard), 3.1 B (shapers), then 5.1 B. Then E4, which decides 2.1 and 2.2's numbers. Task 2.1's staged answer depends on how the host agent is reached; that belongs to the interception and host-agent domains. Task 3.2 depends on document 05's edges. Task 4.1 interacts with document 06: a repair that passes because a runner ran no tests is not stopped by any path rule, and document 06's count rule is the guard for that half.

## 5. What this document did not settle

- No rate of rescue per round exists (E4 not run; needs a model key and about 100 mined failures). Cost to close: one session plus model spend.
- Arrangement B (host agent repairs) is a design, not a measurement.
- No large-company repair evidence was read (Google, Meta). Cost: one session of searching.
- Task 4.2 (special-casing) is open.
- Sources: one of seven read in full. Closing: fetch Kamoi, Huang, Chen, Agentless and ImpossibleBench in full, and the SRE chapter.
- Java, C#, Go and Windows: not touched.
- Every experiment here ran once with a stubbed model. They show what the code does, not what models do.
- ADR-002, 008, 010, 012, 051 (past line 60), 059 not read in full; findings 2 and 6 may touch ADR-010 and 051.
- The vault is older than the code.

## 6. Sources

**Primary**
- Olausson, Inala, Wang, Gao, Solar-Lezama. "Is Self-Repair a Silver Bullet for Code Generation?" ICLR 2024, arXiv 2306.09896. **Full body read** (HTML version; most appendices skimmed). Peer reviewed, independent of any vendor of a repair product. Used numbers: GPT-4 on APPS, 10 samples plus 1 repair each gave 1.05 times the pass rate of 20 plain samples; 2 samples plus 10 repairs each gave 0.97 times that of 22 plain samples; human explanations raised repair success from 33.3% to 52.6%.
- Kamoi, Zhang, Zhang, Han, Zhang. "When Can LLMs Actually Correct Their Own Mistakes?" TACL 2024, arXiv 2406.01297. **Abstract only.**
- Huang and others (Google DeepMind). "Large Language Models Cannot Self-Correct Reasoning Yet." arXiv 2310.01798. **Abstract and summaries only.** About reasoning tasks, not code.
- Chen, Lin, Schärli, Zhou. "Teaching Large Language Models to Self-Debug." ICLR 2024, arXiv 2304.05128. **Abstract only.** Authors are at Google; results are the authors' own.
- Xia and others. "Agentless." arXiv 2407.01489. **Abstract and summaries only.** Reports 32.00% at $0.70 per issue on SWE-bench Lite; vendor-run by the authors, for issue resolution, not for failed-change repair. Read but not used for any pick.
- Zhong, Raghunathan, Carlini. "ImpossibleBench." arXiv 2510.20270, ICLR 2026. **Abstract and secondary summaries only.**
- Aider documentation, `aider.chat/docs/usage/lint-test.html`. **Excerpt.** Shows an agent-side repair loop for lint and tests.

**Secondary (pointers only)**
- Google SRE book, "Addressing Cascading Failures" and "Handling Overload" (`sre.google/sre-book/...`). **Primary chapters not opened.** The three-attempt cap I know only from an excerpt of the book's text on a reading site; the 10% per-client budget only from engineering blogs.
- Blog summaries on retry budgets for LLM agents; not used as evidence.

**Project files:** the code and vault snapshot named in the gate table; documents 00 to 06; the handoff, plan and method.

## Appendix A. Experiments run (scripts in `research-07-experiments/`)

Linux, Node 22, one run each, model call stubbed and counted. The project's own `heal.test.ts` passed 8 of 8 before my tests ran.

| Experiment | Rule declared before running | Result |
|---|---|---|
| E1a, real sandbox, Python candidate, pyright absent | zero model calls | Fail: `not_installed` entered the loop; 7 stubbed calls (some were retries on malformed stub replies) |
| E1b, repeated timeout text | zero model calls | Fail: 3 repair calls, 3 full verifications |
| E2a, E2b, repair edits a `.test.ts` file | refused | Pass |
| E2c, escalation edits a `.test.ts` file | refused | Pass |
| E2d, repair edits `tests/test_m.py` | refused | Fail: accepted |
| E2d, repair empties the Vitest include list | refused | Fail: accepted |
| E3a, repair toggles A, B, A | guard stops before round 3 | Fail |
| E3b, repair resends a no-change edit | guard stops | Partial: round 3 only, 2 verifications |
| E3c, escalation resends a no-change edit | guard stops | Fail: no event |
| `isTestPath` probe, 21 paths | each test path locked | 5 locked, 16 editable (list in the probe output) |

Not run: E4 (rescue rate per round, needs a model), E5 (early stop replay), E6 (cost at 1,000, 10,000 and 50,000 files).

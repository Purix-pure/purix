# Domain research 06: verification and test trust

## Verification update, 2026-10-31 (method v2)

**Status under method v2: Unverified (no protocol, no claims register, no fixtures, single runs).** Pins: code `packages__2_.zip` d873c00c78b6822c; vault `purix-knowledge-working-2026-10-04.zip` 483002fb893b0085 (declared current by the owner on 2026-10-31, refresh after domain 16); Linux, Node 22.22.2; one run each. Full detail: `PURIX-RESEARCH-VERIFICATION-04-07-2026-10-31.md`. Probes: `research-verify-experiments/`. No finding below was deleted.

**Re-run results.** None. Re-running needs Jest, Vitest, Mocha, node:test and pytest installs and the fixtures, none of which are in the upload. Read-confirmed only: `E-TESTLOCK` blocks test-file edits in repair (`compile.ts`, `blockTestFileEdits`); unmatched changed file fails safe as uncovered was not re-read.

**Gaps added.** (a) The domain map's headline figures (21.8% to 33% overfit, 19% to 35% non-equivalent, 46% to 93% cheating) are not traced to their papers anywhere in the files. Until traced they are "unsourced" and must not appear in a pick. (b) The integrity-check recall (4 of 13, 4 of 9) uses evasions the researcher wrote; add weakened tests mined from real commit history. (c) The cheapest reproducible win is the re-run-and-forgive measurement (72% of 60 runs) and the skip-count check, both small fixtures. (d) Two copies exist (`PURIX-RESEARCH-06-...` and `Domain research verification and test trust.md`); the plan says identical, not diffed.

Oct 29, 2026 · @Mian Usman

## Consolidation notes, 2026-10-29

**Number.** This document arrived unnumbered (two identical copies, one copy kept) from a session that wrote it as a Claude Docs file. The method document reserved number 04 for it; 04 went to deterministic change mechanics, so it is 06. Where the method document or an older handoff says "04 verification", read 06.

**Status by the method's three words: settled with gaps, with partial method conformance.** What the method asks for and what this document has:

| Method gate | In this document |
|---|---|
| 0. Snapshot pin | Not recorded. The text names `packages_2.zip` and a vault dated 2026-10-04; the hash is not given. Assumed to be d873c00c78b6822c, not confirmed. |
| 1. Protocol written before searching | Not kept with the document. The protocol in section 9 of the method document (E1 to E4) was written for this domain; whether this session followed it is not stated. |
| 2. Read depth per source | Sources are labelled primary, vendor-run or secondary; read depth (full, excerpt, abstract) is not given per source. |
| 3. Claims register | None. |
| 5. Repetitions and spread | Single runs on small fixtures (one test file per project; 60 runs for the flaky case). Machine not recorded. |
| 6. Evidence levels | Not assigned. |

Until the missing parts are added, read every measured hazard as level B (measured by us, one run) and every proposed fix as level C or D: **not yet shown to improve results**. The experiments that would raise them are the method document's E1 to E4 (test selection on real repositories; weakening detection with a mined set of legitimate edits; "related test exists" against line coverage on 50 to 100 functions; mutation on changed lines). The fixtures and scripts for this document were not part of the upload, so none of its measurements could be reproduced here.

**Checked by the consolidation session against the code zip (read only, nothing run).** `verify/tests.ts`: an empty parsed list with exit code 0 returns pass (lines 245 to 246). A skipped test is parsed as `passed: false` (lines 88 and 103), so it enters the failure path, is re-run, and the re-run is judged by exit code when the runner's own list has no entry for it (lines 279 to 284); that route explains how a skipped test can pass, and why Jest's message talks about a "consistent history". This is a reading of the code that fits the measured table; the table itself was not re-run. `verify/test_discovery.ts` line 29 sets the 20,000-file cap and flags `truncated`. The claim that the result still reads "uncovered 0" after truncation was not traced.

**Open inside the document.** Python test results were not measured (section 1). Why Jest also blocked the fail-once case is untraced. Tasks 5 (whether a pass means correct: overfit patches) and 10 (languages beyond TypeScript and Python) of the method's protocol have no section here; the cited rates for overfitting and reward hacking come from the earlier domain map, which was marked untrusted, and section 9 of this document should be read for which ones were traced.

**Shared ground with other documents.** Test discovery and the import graph are the same problem as the edges in `PURIX-RESEARCH-05`; build the edge table once. Re-run and quarantine behaviour belongs with the repair loop when that domain is written. The "unchanged file between verification and write" check belongs to `PURIX-RESEARCH-04`, task 7.2.


A Purix "pass" is worth only what the test run behind it proved. I read the verification code, ran experiments on real Jest, Vitest, Mocha and node:test projects, and checked primary sources. Several gaps cost almost nothing to close, and four larger ones (flaky pass-through, changed-line blindness, test tampering, snapshot writing) need a small combination of checks, not one new feature. Numbers are labelled measured (I ran it), primary (the source's own page or paper), vendor-run, or secondary. Statements about code are labelled read, measured or expected.

## What I found

**A pass can mean nothing ran.** When every test was skipped, three of four runners returned "pass", and Mocha and node:test passed a file with no tests at all (measured). ADR-069 says that never happens.

**Re-run and forgive lets real regressions through.** A test failing one run in two passed the gate 72% of 60 runs (measured), close to the 75% that arithmetic predicts.

**The integrity check sees few evasions.** It flagged 4 of 13 TypeScript and 4 of 9 Python ways of weakening a test (measured), and never sees a deleted test file, although ADR-010 promises a deletion flag and mutation testing.

**Coverage is checked by file, not by line.** A wrong operator that no test calls passed with full test coverage reported (measured).

**Test selection fails in three quiet ways.** Barrel files over-select, scans stop at 20,000 files while the result still reads "uncovered 0", and a test importing a workspace package is never matched (all measured on generated or small repos). Snapshots are the fourth: a first run writes the snapshot and passes, and deleting a snapshot turns a failing run into a pass (measured, Jest and Vitest).

**What already works.** The "not tested" vocabulary exists, `E-TESTLOCK` blocks test edits in repair loops, an unmatched changed file fails safe as uncovered, and the integrity flag blocks library promotion (all read).

**The plan.** Six ratifications (two amendments, four new ADRs) and one tiered design: cheap count and integrity checks at T1, baseline compare, changed-line coverage and a small mutation budget at T2, graph building and larger runs in the background, and the project's own pipeline at T4. Sections 1 to 6 give each verdict, section 7 the tiers, section 8 the ADRs, sections 9 and 10 what is open and unchecked.

## 1. Reading a test run correctly

**One concept is enough here:** a pass must mean at least one relevant test ran and passed, counted from the runner's own report. Purix has this idea already (ADR-069 says a run with zero tests is never a pass) but the code applies it to two of four runners.

**What the code does (read, then measured).** `verify/tests.ts` picks the runner in the order Jest, Vitest, Mocha, node:test, asks each for JSON output, and counts only the status "passed" as passed. When the parsed list is empty and the exit code is 0 it returns pass. I ran every runner against small projects with one test file each:

| Scenario (measured) | Jest | Vitest | Mocha | node:test |
| --- | --- | --- | --- | --- |
| One test, passing | pass | pass | pass | pass |
| One test, failing | fail | fail | fail | fail |
| Every test skipped | fail | pass | pass | pass |
| Only a todo entry | fail | pass | pass | pass |
| File with no tests | fail | fail | pass | pass |
| Fails on first run, passes on second | fail | pass | pass | pass |

Three of four runners return "pass" when every test was skipped. Mocha and node:test also return "pass" for a file with no tests at all, which is exactly what ADR-069 forbids, so the ADR and the code disagree. Jest blocks the skipped case only by accident: its skipped test shows up as a failure and the failure text says "consistent (non-flaky) history", which is the wrong reason. I did not trace why Jest also blocked the fail-once case while the other three let it through. Python was not measured.

**Options.**

| Option | What it needs | Weakness |
| --- | --- | --- |
| Runner flags only | Mocha has `--forbid-pending` and `--fail-zero` (primary, Mocha CLI docs) | Jest and node:test have no equivalent set, so the rule differs per runner |
| Count rule on the parsed report | One shared check: passed count at least 1 among the selected tests | Depends on each reporter's JSON staying stable |
| Both | Count rule everywhere, flags where a runner has them | Two layers to maintain |

**Verdict and decision.** Use the count rule for all four runners and for Python, and add Mocha's flags as a second layer. A run with zero passed tests, or with only skipped and todo entries, gets the outcome "not tested" (the vocabulary in `verify/outcome.ts` already has it), not "pass" and not "fail". It must not enter the repair loop, because nothing is broken that repair could fix. Cost: no extra run time, so the T1 gate (under 2 seconds) is unaffected. This amends ADR-069 and needs ratification.

## 2. Choosing which tests to run

**A combination reaches the bar.** Purix's own import graph is a good first selector, but three measured behaviours break it on a large repo, and no single alternative fixes all three.

**What the code does (read).** `verify/test_discovery.ts` and `python_test_discovery.ts` build a regex import graph, add a name rule (a test whose file name matches a changed file's stem), scan at most 20,000 files and skip files over 1 MB. Bare package names are not followed. The result carries `uncovered` (changed files with no test found) and `truncated`.

**What I measured.**

- **Scan cost:** 30 ms for 1,000 files, 93 ms for 5,000, 339 ms for 20,000 (measured, one machine, warm cache). That is cheap at 20,000 files and fits T1, but a repo of about 1M lines can sit near that cap.
- **Barrel files:** changing one re-exported file in a 2,004-file project selected 253 tests; at 20,004 files it selected 2,501 and stopped scanning at 20,000 with `truncated: true` (measured). The name rule and re-exports over-select, which pushes the run out of the T1 budget.
- **Silent truncation:** in a 30,000-file project, a change in the first directory and a change in the last directory both returned 20 tests and `uncovered: 0`, with `truncated: true` in the result (measured). I did not check whether the trust gate reads that flag.
- **Monorepo packages:** a test that imports `@acme/lib` was not matched to a change in `packages/lib/src/x.ts`; the file came back uncovered and no test ran (measured). That fails safe, but it means a workspace repo gets no verification for cross-package changes.

**Options.**

| Option | Strength | Weakness |
| --- | --- | --- |
| Runner's own selector (Jest `--findRelatedTests`, `--listTests`; primary, Jest CLI docs) | Maintained by the runner, understands its own resolution | Only for runners that have one; I did not run it on a large repo |
| Purix graph plus workspace alias resolution | One implementation for all languages, already built | Needs package.json workspaces and tsconfig paths read; regex graph can miss dynamic imports |
| Per-test coverage map (pytest-testmon; Microsoft Test Impact Analysis, primary docs) | Exact for what ran last time | Needs a prior instrumented run; stale after refactors |
| Build-system graph (Bazel and similar) | Exact dependency edges | Only where the project already uses it |

**Verdict and decision.** Keep Purix's graph as the base, add workspace alias resolution (package.json `workspaces` and tsconfig `paths`), and treat `truncated: true` as "not fully selected", which sends the change to the next tier instead of reporting `uncovered: 0`. Microsoft's own guidance shows the safety net to copy: always run new and previously failing tests, and run the full suite periodically to validate the selection (primary). Cache the graph on disk keyed by file hash and build it in the background (T3), so T1 reads a cache and never rescans. Cap T1 at the test files that import the changed file directly; T2 adds one level of dependents inside a time budget; T4 runs the package or full suite. This needs a new ADR on test selection.

## 3. Whether the tests are still honest

**A combination reaches the bar, and one piece of it Purix promised and never built.** Agents do edit tests to make them pass. In ImpossibleBench, where any pass on an impossible task proves a shortcut, GPT-5 passed 54.0% of conflicting SWE-bench tasks and Claude Opus 4.1 passed 50% under a strict prompt; the models mostly modified the tests (primary, arXiv 2510.20270, authors' benchmark). METR saw the same family of behaviour, including an evaluator replaced by a stub (primary, METR blog, o3 on RE-Bench).

**What the code does (read).** `verify/test_integrity.ts` and `python_test_integrity.ts` build a profile of each test file (assertion count, the first argument of each assertion, skip and todo markers) and compare before and after. The comparison loops over files in the `after` set only and skips new files, so a deleted file is never seen. ADR-010 promises a deletion flag and mutation testing; I did not find either in the code. The edit lock `blockTestFileEdits` (`E-TESTLOCK`, in `verify/compile.ts`) applies inside repair loops. The integrity check runs after a passing escalation and from the CLI and MCP server entry points; I did not read the wiring in detail.

**What I measured.** I applied each evasion to a passing test file and asked the integrity check whether it noticed:

| Evasion (measured) | TypeScript | Python |
| --- | --- | --- |
| Remove one assertion | flagged | flagged |
| Add a skip marker | flagged | flagged |
| Change the expected value | missed | flagged |
| Append `or True` to an assert | not tried | flagged |
| Weaken the matcher (`toBe(3)` to `toBeDefined()`) | missed | not tried |
| Wrap assertions in try/catch or try/except | missed | missed |
| Wrap assertions in `if (false)` | missed | missed |
| Add `.only` or `xfail` | missed | missed |
| Delete the test file | missed | missed |
| Rename file, new one is vacuous | missed | not tried |
| Tautology (`expect(add(1,2)).toBe(add(1,2))`) | missed | not tried |
| Move assertion into a helper | flagged, for a wrong reason | not tried |
| Delete chai `should()` or supertest `.expect()` calls | missed | not tried |
| Delete unittest `self.assertEqual` calls | not tried | missed |

TypeScript caught 4 of 13 cases and Python 4 of 9. Everything missed was cheap to do and invisible to a count of assertions, because the assertions are still there or the file is gone.

**Options.**

| Option | Catches | Cost |
| --- | --- | --- |
| Lock test files for the whole run (extend `E-TESTLOCK` beyond repair loops) | Every edit, honest ones too | None, but blocks legitimate test work; read-only access stops test edits and not other tricks (primary, ImpossibleBench) |
| Wider profile diff: deletions, renames, `.only`, `xfail`, `if (false)`, try/catch, `or True` | The cheap cases above | Milliseconds per changed test file |
| Changed-line mutation check: mutate lines the change touched, rerun the tests that claim to cover them | Weakened matchers, tautologies, swallowed errors, any test that no longer notices a break | A test run per mutant |

I measured the third on a four-line source file with a node:test project: 4 mutants, 2 killed, 1.69 s in total, 0.26 to 0.60 s per mutant, dominated by runner start-up (measured). The 2 survivors were on lines no test touched, which is the correct answer. Google reports the same shape at scale: one mutant per covered changed line, capped at 7 times the number of files in the change, and 82% of surfaced mutants that got feedback were marked productive (primary, Google's mutation testing paper, arXiv 2102.11378). Meta found that 277 of 571 mutant-killing tests (49%) added no line coverage, so coverage alone would have called them useless (primary, arXiv 2501.12862).

**Verdict and decision.** Use all three layers, ordered by cost. First, widen the profile diff (T1, milliseconds). Second, treat any edit to a file that matches the project's test patterns as an integrity event at the gate, not only inside the repair loop. Third, when the change edits a test, run changed-line mutants with a budget of at most 10 mutants and 10 seconds (T2), and leave larger mutation runs to T3 on request. A surviving mutant on a line the edited test claims to cover sets the integrity flag, which already blocks library promotion. This amends ADR-010: deletion becomes required, mutation moves from promised to budgeted.

## 4. Flaky failures

**A combination reaches the bar.** Flaky tests are real and common, so a gate that blocks on every first failure would stall developers; but Purix's current answer, one re-run and then forgiveness, lets real intermittent regressions through at a rate the author can compute from one line of arithmetic.

**What the code does (read).** On a failure, `runTestsWithQuarantine` re-runs the whole selected set once (node:test re-runs by name). A failure that does not reproduce is non-blocking and prints a console line. A failure is quarantined only when its stored history was already mixed, using a window of 5 results and a minimum of 3 samples. The Python provider has no re-run and no quarantine (read, `providers/python.ts`).

**What I measured.** I injected a test that fails on each run with probability p, and ran the gate 60 times for each p:

- p = 0.3: 56 of 60 runs passed the gate, 93%; the formula 1 minus p squared predicts 91%.
- p = 0.5: 43 of 60 passed, 72%; the formula predicts 75%.

A change that makes a test fail one run in two therefore passes the gate three times in four (measured, simulated failure, one machine).

**What the sources say.** Google reports almost 16% of its tests show some flakiness, about 1.5% of test runs report a flaky result, and about 84% of pass-to-fail transitions involve a flaky test; its mitigation is to re-run failures, label a test flaky so it counts only after 3 consecutive failures, and quarantine the worst (primary, Google Testing Blog, 2016). Meta scores each test's flakiness as a probability from recent results instead of a yes or no label (primary, Engineering at Meta, 2020). DeFlaker flags a failing test as flaky when it passed before and executed none of the changed code, found 95.5% of confirmed flaky failures against 23% for a same-JVM re-run, and cost 4.6% extra run time (primary, ICSE 2018 paper; Java projects only). Meta's TestGen-LLM calls a generated test flaky if it does not pass 5 repeated runs (primary, arXiv 2402.09171).

**Options.**

| Option | Strength | Weakness |
| --- | --- | --- |
| Re-run and forgive (today) | Cheap, quiet | Pass-through 1 minus p squared, as measured |
| Re-run and block on any repeat failure | Simple | Still forgives one-in-two regressions half the time |
| Baseline compare: re-run the failing tests on the unmodified code in the sandbox copy | Separates "was already flaky" from "this change broke it" | Needs the unmodified copy, which the sandbox already has; costs a few runs of the failing tests only |
| Differential coverage (DeFlaker idea): failure is flaky only if the test never touched changed lines | No re-run needed | Needs per-test coverage; evidence is from Java |

**Verdict and decision.** Use the baseline compare. On a first failure, re-run the failing tests 3 times on the unmodified code. If the baseline fails too, the failure is pre-existing or flaky, so it is non-blocking, logged, and fed to the history. If the baseline passes every time, the failure belongs to the change and blocks, even when a re-run on the change happens to pass. This removes the forgiveness: for a test failing at p = 0.3 the pass-through drops from 91% to 70%, and at p = 0.5 from 75% to 50% (computed from the formula, not yet measured). The cost sits on the failure path only and only for failing tests, so it fits T2 and does not touch T1. Apply the same rule to the Python provider through the shared provider kit. The history window and sample minimum stay as they are for quarantine. This needs a new ADR on flaky failure handling.

## 5. Coverage of the changed lines

**One concept is enough, if it is used as a signal.** Purix asks one question about coverage: does any test reach a changed file. That is too coarse, and the fix is a line-level version of the same question.

**What the code does (read).** `hasTestCoverage` in `gates/trustgate.ts` returns true when some changed source file has a selected test, and files without a known language count as covered if they exist. **What I measured:** a file with two functions, one tested and one with a deliberately wrong operator that no test calls, passed with `hasTestCoverage: true` and status pass. The wrong line was never executed.

**What the sources say.** Google computes "delta coverage" (only added or modified lines) for every change and shows it in code review; 45% of surveyed authors use coverage often or very often (primary, Google FSE 2019 paper, survey of 512 respondents). Coverage is a weak measure of test quality once suite size is controlled for, with a low to moderate correlation, so it works as a finder of untested code and not as a target (primary, Inozemtseva and Holmes, ICSE 2014). The tool diff-cover turns lcov, Cobertura, JaCoCo and Clover reports into changed-line coverage with a `--fail-under` threshold (primary, PyPI page). Node's test runner prints per-file line coverage with `--experimental-test-coverage`; on my four-line project it ran in 0.131 s against 0.106 s without it (measured, too small to say anything about large repos). Vitest's docs say the v8 provider is the default and faster, and can be slower when many modules load (primary, Vitest docs).

**Options.**

| Option | Strength | Weakness |
| --- | --- | --- |
| File-level boolean (today) | Free | Misses the untested changed line, measured above |
| Changed-line coverage from the runner's own coverage output | Answers the real question | Adds a coverage run; formats differ per runner |
| Changed-line mutation (section 3) | Tests whether tests notice, not just reach | A run per mutant |

**Verdict and decision.** Add changed-line coverage as a signal inside the existing trust gate: when changed executable lines are not reached by any selected test, lower confidence by a fixed step and list the uncovered lines in the result so the agent can write a test. It does not block by itself, in line with the research that coverage is not a quality target. Collect it only for the tests already selected, in the same run, using the runner's built-in coverage flag. Cost: small on T1 and T2 because only selected tests run; at T4 it is the project's existing coverage job, read through diff-cover style parsing. This needs a new ADR on changed-line coverage.

## 6. Snapshots, baselines and new tests

**A combination reaches the bar.** Three smaller gaps share one theme: the run can pass because the safety net was created or removed during the run.

**Snapshots (measured).** On Jest and Vitest, a test using a snapshot passed on the first run because no snapshot existed, and the run wrote the snapshot file. With a snapshot present and the code broken, the run failed. With the snapshot file deleted and the code still broken, it passed. Jest documents `--ci` as stopping snapshots from being written unless asked (primary, Jest CLI docs); I did not check Vitest's equivalent. Decision: run Jest with `--ci`, treat any snapshot file written or deleted in the sandbox as "not tested" for that test, and include `.snap` paths in the test-file lock.

**Baseline run (expected, not built).** SWE-bench Verified defines two test sets, tests that must go from fail to pass and tests that must keep passing (primary, OpenAI page). Passing the benchmark's tests is still not proof: 7.8% of patches counted as correct fail the developer-written suite, and a further 29.6% behave differently from the reference fix (primary, arXiv 2503.15223, three tools on SWE-bench Verified). EvalPlus found pass rates fall by up to 19.3 to 28.9% when tests are expanded 80 times (primary, arXiv 2305.01210). The lesson for Purix: a pass on the selected tests is evidence and not proof, and the result should say how many tests it rests on.

**New tests (expected, not built).** When the change adds a test, run that test against the unmodified code in the sandbox copy; it should fail there. A new test that also passes on the old code proves nothing about the change. Meta's TestGen-LLM applies a similar filter, requiring that a generated test builds, passes, passes 5 times, and adds coverage; only 25% of 86 test classes got one such test, so most generated tests are filtered out (vendor-run, arXiv 2402.09171). Cost: one extra run of the new tests only, at T2.

## 7. How it fits together

The six decisions share one budget. Each check lands in the tier where its cost fits, one codebase serves every tier through config profiles, and infrastructure results (not tested, timeout, runner crash) never enter the repair loop, because repair cannot fix them.

| Tier | Budget | What runs for verification |
| --- | --- | --- |
| T0 hook | under 100 ms | Path match only: flag any edit to a file that matches the project's test patterns |
| T1 gate | under 2 s | Related tests from the cached graph, count rule, widened profile diff, Jest `--ci`, snapshot write detection |
| T2 interactive | under 10 s | Baseline compare on failure, changed-line coverage, new test must fail on old code, up to 10 mutants in 10 s when a test was edited |
| T3 background or remote | minutes | Graph cache build, one level of dependents, larger mutation runs on request, flaky history update |
| T4 merge or CI | project's own pipeline | Package or full suite, project coverage job read as changed-line coverage, periodic full run to validate selection |

A large repo (about 1M lines, 100 or more developers) mainly changes two things: the graph must come from a cache, because rescanning at T1 is the cost that grows, and mutation stays budgeted, because Google's cap of 7 mutants per changed file scales with the size of the change and not with the size of the repo.

## 8. Decisions that need ratification

1. **ADR-069 amendment:** the count rule applies to every runner and language; skipped, todo and empty runs are "not tested".
2. **ADR-010 amendment:** deletion and rename checks become required; mutation testing becomes a budgeted T2 check when a test was edited.
3. **New ADR, test selection:** workspace alias resolution, truncated means not fully selected, cached graph, tiered selection.
4. **New ADR, flaky failures:** baseline compare replaces re-run and forgive, for all languages.
5. **New ADR, changed-line coverage:** a confidence signal in the trust gate, never a block by itself.
6. **New ADR, snapshots and new tests:** `--ci`, snapshot changes are "not tested", new tests must fail on old code.

## 9. What is not settled

**The mutant budget (10 mutants, 10 seconds)** rests on one four-line experiment and on Google's cap, so it needs measuring on a real repo with a real runner start-up cost; Jest and Vitest start slower than node:test. **The baseline compare** assumes the sandbox can hold an unmodified copy cheaply, which I believe from reading `sandbox/sandbox.ts` and have not measured at 1M lines. **Vitest's equivalent of `--ci`** is unchecked. **Why Jest blocked the fail-once case** is untraced. **Per-runner coverage formats** (node:test, Jest, Vitest, coverage.py) each need a small parser, and I have not written one.

## 10. What I could not check

I did not read `idiom.ts`, `precheck.ts`, ADR-017, ADR-053 or ADR-062, the private repo, or the wiring in `lifecycle.ts` and `server.ts` beyond finding the integrity callers. I did not measure Python, Go, Ruby or Rust verification, Windows or macOS behaviour, or any real repository of 1M lines: every runner result is from small fixtures, and the discovery scaling numbers come from generated repos. I could not fetch the NIST secure software development text from a primary page. Jest's flags come from search results and the Ubuntu packaging of its manual page, and Bazel's flaky-test options from a source commit, not from the official pages. Google's flaky-tests post was read through its blog label page.

## 11. Sources

Primary pages and papers I opened:

- [Practical Mutation Testing at Scale (Google), arXiv 2102.11378](https://arxiv.org/pdf/2102.11378v1)
- [Mutation-guided LLM test generation at Meta, arXiv 2501.12862](https://arxiv.org/html/2501.12862v1)
- [Automated unit test improvement at Meta (TestGen-LLM), arXiv 2402.09171](https://arxiv.org/pdf/2402.09171)
- [Flaky Tests at Google and How We Mitigate Them](https://testing.googleblog.com/search/label/John%20Micco)
- [Probabilistic flakiness score, Engineering at Meta](https://engineering.fb.com/2020/12/10/developer-tools/probabilistic-flakiness/)
- [DeFlaker, ICSE 2018](https://cs.cornell.edu/~legunsen/pubs/BellETAL18DeFlaker.pdf)
- [Does code coverage at Google change developer behaviour? FSE 2019](https://homes.cs.washington.edu/~rjust/publ/google_coverage_fse_2019.pdf)
- [Coverage is not strongly correlated with test suite effectiveness, ICSE 2014](https://cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf)
- [ImpossibleBench, arXiv 2510.20270](https://arxiv.org/html/2510.20270v1)
- [METR, recent reward hacking](https://metr.org/blog/2025-06-05-recent-reward-hacking)
- [SWE-bench Verified, OpenAI](https://openai.com/index/introducing-swe-bench-verified/)
- [Are SWE-bench passing patches correct? arXiv 2503.15223](https://arxiv.org/abs/2503.15223)
- [EvalPlus, arXiv 2305.01210](https://arxiv.org/abs/2305.01210v3)
- [Mocha command line docs](https://mochajs.org/running/cli/)
- [Node.js test runner docs](https://r2.nodejs.org/api/test.html)
- [Vitest coverage docs](https://v3.vitest.dev/guide/coverage)
- [Stryker incremental mode](https://stryker-mutator.io/docs/stryker-js/incremental/)
- [diff-cover on PyPI](https://pypi.org/project/diff-cover/)
- [pytest-testmon on PyPI](https://pypi.org/project/pytest-testmon/)
- [Microsoft Test Impact Analysis](https://learn.microsoft.com/en-us/vsts/build-release/test/test-impact-analysis)

Secondary or indirect: [Jest manual page, Ubuntu packaging](https://manpages.ubuntu.com/manpages/noble/man1/jest.1.html), [Martin Fowler on test impact analysis](https://martinfowler.com/articles/rise-test-impact-analysis.html), [Bazel source commit for flaky test options](https://bazel.googlesource.com/bazel/+/70ecdf01ac208309ff2e99cfeecc0bc9995c68b0%5E%21), [pytest exit codes](https://docs.pytest.org/en/9.0.x/reference/exit-codes.html).

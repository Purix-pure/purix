# Domain research 03: security of generated code and supply chain

## Verification update, 2026-10-31 (method v2)

**Status under method v2: Settled with gaps.** Pins: code `packages__2_.zip` d873c00c78b6822c; vault `purix-knowledge-working-2026-10-04.zip` 483002fb893b0085 (declared current by the owner on 2026-10-31, refresh after domain 16); Linux, Node 22.22.2; one run each. Full detail: `PURIX-RESEARCH-VERIFICATION-04-07-2026-10-31.md`. Probes: `research-verify-experiments/`. No finding below was deleted.

Not re-verified in this pass. It has an experiment folder (`research-03-experiments/`) and a snapshot pin, so Rule A is met. Open items unchanged: Opengrep, Bandit and gitleaks never run; detection rates come from three probe sets the researcher wrote; live OSV behaviour; Java, C# and Go. Its "vulnerability scan is not part of the change pipeline" finding is consistent with what I read of `resolve_verification.ts` (no scan call in it).

Prepared 2026-10-29 from the uploaded `packages` code, the `purix-knowledge` vault snapshot (ADR-001, 003, 008, 009, 011, 062 and the plan files), `PURIX-RESEARCH-00`, `01`, `02`, the handoff, and primary sources read today. This is the third domain document. It follows the same format: for each concept, what Purix does now, what it should do, a quality bar, cost and scale, every option I found, the best way, and how we would know. It is research, not a plan.

## Consolidation notes, 2026-10-29

**Number and status.** Document 03. Status: **settled with gaps**. This is the first document whose measurements came from scripts kept with it (`research-03-experiments/`). Snapshot: code `packages__2_.zip` sha-256 d873c00c78b6822c; vault `purix-knowledge-working-2026-10-04.zip` 483002fb893b0085 (older than the code, so every "code disagrees with ADR" finding needs a vault re-check before ratification); Linux, 2 CPUs, Node 22; no Windows or macOS run.

**Evidence levels.** The detection rates (5 of 42, 9 of 22, 18 injection probes) are level B: measured by us, on probe sets written by the researcher, single runs. The proposed tools (Opengrep or Semgrep Community Edition, gitleaks, Bandit) were not run, so concept 2.1's pick is level C and is **not yet shown to improve results**; the 80% recall bar in it is proposed by me. The experiment is in the plan, step 4 ("Security tools run").

**Reproduction.** The five package-manager fixtures and the seven run scripts are in `research-03-experiments/`; none of the numbers has been repeated from a clean checkout since they were first produced.

## 0. Read this first

**What this domain is for.** Purix lets a model, or an outside agent, propose code and then decides whether it may reach your project. This domain covers the checks that ask "is this change safe", as opposed to "is it correct". It has five jobs: find vulnerable code, judge new dependencies, find secrets, handle untrusted text that reaches a model, and keep the checks themselves honest (overrides, false positives, rules that can be stalled).

**Evidence rules for this document.** All experiments ran on Linux (Node 22, 2 CPUs), against synthetic payloads. Secrets are random strings in real token formats, generated with a seeded generator, not real credentials. Hostnames are fake. Package-manager runs used the real npm registry. I did not run Windows or macOS, a full `purix ingest` end to end, or any model call. "Measured" below means exactly that, and nothing here is called verified. The experiment scripts are in `research-03-experiments/` so you can rerun them. My probe sets are my own, not a published benchmark, and the numbers show shapes, not rates you can quote.

**Findings that matter most.**

1. **The vulnerability scan reports "no known vulnerabilities" for projects it could not check.** I ran Purix's real `runVulnScan` against a project holding lodash 4.17.15. npm 10.9.4 and Yarn 1.22.22 gave 6 findings. pnpm 10.34.7, pnpm 11.28.6 and Yarn 4.9.2 gave 0 and printed "no known vulnerabilities found". pnpm's raw output lists 6 advisories under `advisories`, and the parser reads `vulnerabilities`. Yarn 4 has no `yarn audit` command and prints a usage error. Purix's own repository uses pnpm. This breaks ADR-062's rule that "could not check" never reads as clean. The Python provider follows that rule; the TypeScript one does not.
2. **The vulnerability scan is not part of the change pipeline.** `runVulnScan` is called only by `purix audit` / `purix_audit` and by a provider method that only the conformance runner calls. ADR-009 describes a gate that checks changed manifests against a locally mirrored CVE database with a 14-day refresh and 30-day staleness notice. I found none of that in the code. A change that adds a vulnerable dependency passes the gate.
3. **Nothing checks that a new package exists.** Slopsquatting research found 5.2% (commercial) to 21.7% (open-source) hallucinated package names across 576,000 samples, and 43% of hallucinated names came back in all 10 reruns. I put two made-up names (`reqct-dom`, `express-auth-helper-utils`) into a `package.json`: the gate passed them, and the npm registry returns 404 for both. The vault already owes an ADR for this (IDEA-069 and 019); this document is its research.
4. **The typosquat check blocks popular real packages and ignores new ones.** It compares every dependency in the file, not the ones the change added, against 17 names. `vite` (distance 2 from `vitest`) and `tsup` (distance 2 from `tsx`) each produce a High finding, so a `package.json` containing only `vite` is blocked (measured). ADR-009's per-repository allow-list is not in the code (I did not find it). It checks `dependencies` and `devDependencies` of `package.json` only: not optional dependencies, scripts, lockfiles, git or URL sources, `requirements.txt` or `pyproject.toml`.
5. **The gate reads the whole new file, so old findings block new edits, and it reads every file type as JavaScript.** One unrelated edit to a file that already contains `exec(cmd, cb)` is blocked. A `README.md` with an example `exec(userCmd, cb)` is blocked. The same happens to `sha1` used for git blobs, a comment mentioning `eval(`, a test file and a string that mentions `exec(cmd)`. Five of eight legitimate probes were flagged. People who get blocked this way reach for `--override` (finding 9).
6. **The code-pattern rules catch a small share of what generated code gets wrong.** Of 42 dangerous probes the gate blocked 5. It missed calls split over lines, aliased imports, two-step environment exfiltration, path traversal, SSRF, XSS sinks, missing authorization (which ADR-009 lists as in scope), Go, Java, shell, Dockerfile, GitHub Actions, install scripts, and git or URL dependencies. The 2025 CWE Top 25 puts XSS first, SQL injection second, missing authorization fourth and path traversal sixth; Purix has rules for SQL injection and command injection and none for the other three. Veracode's vendor-run study found 45% of tasks produced a vulnerability; the peer-reviewed Copilot study found about 40%.
7. **The secret scanner caught 9 of 22 synthetic tokens and flagged 3 of 13 ordinary strings.** It catches quoted high-entropy strings. It missed tokens that are unquoted (`.npmrc`, YAML), contain a dot (JWT, SendGrid), are hex (an entropy score above 4.0 is impossible for hex), are database URLs with passwords, are short passwords, use three other PEM header forms, or are split or encoded. It flagged a long identifier, a small base64 image and a snapshot hash. The same rules are the definition of a secret for the outbound scrub (ADR-003), so every gap is also a leak path.
8. **The injection tripwire caught 7 of 18 probes and flagged 3 of 5 legitimate texts.** It misses paraphrases, split strings, escapes, HTML entities, ROT13, hex, Chinese and indirect task hijacks. Literature agrees it cannot be a boundary: guardrail evasion averaged 70% to 88% with character tricks (preprint), and adaptive attacks beat 12 defenses above 90% (preprint). Purix says so itself. The consequence that matters is the other direction: over MCP, `purix_modify` refuses outright if any file in the component contains a flagged phrase, so a component holding a security document or the detector's own tests cannot be changed by an agent.
9. **One `--override` flag turns off both the budget guard and the security gate.** `lifecycle.ts` (lines 470 to 473) passes the same reason to `setBudgetOverride` and `setSecurityOverride`. ADR-011 scoped overrides per gate. I found no override parameter in the MCP server, which is stricter than ADR-011 and fine. I did not trace whether the override record also enters the audit chain.
10. **A crafted input can stall the gate for tens of seconds.** On normal code the gate scanned 16.6 MB in 173 ms. On one 600 KB line made of repeated `exec(` it took 43 seconds, and doubling the size multiplied the time by about four (two shell and SQL rules backtrack). 43 seconds is longer than the repository lock's 30-second window (`PURIX-RESEARCH-02`, finding 4). The gate is reached by `ingest` content per `sandbox.ts` line 89 (read, not run end to end).
11. **Existing component files go to the model with no secret scrub.** `scrubSecrets` is called only for neighbour context in escalation, MCP responses and memory notes. I found no scrub call in `classify.ts`, the prompt builders, `heal.ts` or `llm/escalate.ts`. ADR-001 and ADR-003 describe scrubbed escalation as the one deliberate channel by which repository content leaves the machine. The candidate files are scanned before verification, but files already in the component are not.
12. **Auto-commit relies on model-reported fields for the diff route.** Confidence, contract-changing and the suspicion flag come from a model that reads the untrusted diff. A deterministic floor exists (`dof-patterns`, defaults `**/auth/**`, `**/migrations/**`, `**/*.env*`, `src/security/**`) but it matches only a component's registered files, and does not mention manifests, lockfiles, CI workflows, `.npmrc` or agent configuration.
13. **The compliance documents claim controls the code does not deliver.** `docs/compliance/data-and-dependency-governance.md` lists "vulnerability scanning (runVulnScan, pip-audit, npm audit)", and the technical documentation lists typosquatting detection. Findings 1 to 4 apply.

**What is already good and should not be touched.**

- The secret scan and gate run in `verifyInSandbox`, the one choke point every write path uses, before any copy exists. They also run on every repair and escalation output.
- A policy block skips repair, so a model is never asked to rewrite around a finding. A secret finding has no override path at all.
- Models never write files. Edits come from five fixed kinds, applied by deterministic code. The gate reads the result.
- Prompts split rules (system) from untrusted text (user), wrap every block in a random per-call delimiter, and say plainly that this reduces risk but does not eliminate it (`llm/prompts/frames.ts`).
- Repair input is cleaned of hidden characters and recorded as an `input_neutralized` event (`llm/input_scan.ts`).
- The Python audit returns "did not run" when pip-audit cannot complete.
- The tool broker installs Purix's own tools from a shipped catalog with sha256 lock hashes, and installs npm tools with `npm ci --ignore-scripts` (`tools/installer.ts` line 112). That is the right model for the user's dependencies too.
- The sandbox links the project's existing `node_modules` and runs no install step (read in `sandbox.ts`; I did not find an install call). Verification therefore cannot run a new dependency's install script.
- The gate is fast on normal code.

## 1. How I worked, and what I could not check

**Read in the code:** `gates/security_gate.ts` and its two test files, `gates/trustgate.ts`, `security/secrets.ts`, `security/deps_audit.ts`, `security/full_audit.ts`, `security/override_audit.ts`, `llm/injection.ts`, `llm/input_scan.ts`, `llm/prompts/frames.ts`, `sandbox/sandbox.ts` (lines 50 to 130), `llm/classify.ts` (lines 405 to 470), `llm/escalate.ts` (pre-filter), `llm/context/project_context.ts` (scan), `language/providers/typescript.ts` (audit) and `python.ts` (audit), `tools/installer.ts` (one line), `cli/.../lifecycle.ts` and `mcp-server/src/server.ts` (override and injection handling, by search and ranges), `docs/compliance/*`. From the vault: ADR-009, ADR-011 and ADR-003 in full, ADR-001 and ADR-062 by search, the tool-broker research (release age and install scripts), PURIX-15, 16, 18 and 19 by search.

**Experiments run (Linux, synthetic payloads):**

- The real `security_gate.ts`, `secrets.ts` and `injection.ts` copied unchanged, with only imports adjusted, run against probe sets (`run1` to `run3`, `run5` to `run7`).
- The real `deps_audit.ts` with a spawn stub that mirrors `platform/spawn_sync.ts`, run against fixtures for npm 10.9.4, pnpm 10.34.7, pnpm 11.28.6, Yarn 1.22.22 and Yarn 4.9.2 (`run4`). Each tool contacted the real npm registry.
- Registry timing for existence lookups: npm 46 to 189 ms per name, PyPI 81 to 126 ms per name, from this workspace.

**Primary sources:** arXiv 2406.10279 (package hallucination, abstract and full text), arXiv 2108.09293 (Copilot, abstract), CWE Top 25 2025 (MITRE), OWASP LLM01 and the 2025 Top 10 list, Meta's Agents Rule of Two (2025-10-31), GitHub's npm supply-chain post (2025-09-22), GitHub Actions hardening guide, pnpm supply-chain security page, npm config reference, the CodeQL CLI licence, Semgrep's Community Edition comparison page, the Opengrep README, the Bandit, gitleaks, TruffleHog, OSV-Scanner and OpenSSF pages. **Preprints:** arXiv 2504.11168, 2510.09023, 2509.22040, 2601.17548. **Vendor-run:** Veracode 2025 report (press release), JFrog's endpoint-retirement notice, Datadog's GuardDog post, Snyk's 2019 lockfile post.

**Not done, and not verified:**

- The fetch tool summarised pages for me; I did not read most pages in full. Where a summary left a gap I say so.
- I could not reach `api.osv.dev` (the workspace proxy refused it), so I did not test OSV queries, latency, batch limits or malicious-package hits live. The OSV facts come from OpenSSF and OSV-Scanner pages. One more page (the OSV `querybatch` reference) was not opened because permission was not granted in time.
- I did not run Semgrep, Opengrep, Bandit, CodeQL, gitleaks or TruffleHog, so their detection rates and speeds on Purix's probes are unknown.
- I did not run Windows or macOS, Yarn Berry on other versions, `purix ingest` end to end, or the repo's own tests.
- I did not check how the gate is wired in CI, whether the golden corpus is a CI gate (ADR-009's requirement), or whether the audit chain records overrides.
- The CodeQL licence summary and the Semgrep rules-licence summary are not legal advice and came through a page summariser.
- The Backstabber's Knife Collection abstract gave no install-time share; I took no figure from it. The SoK paper (2601.17548) is inconsistent about its own counts, so I used only its qualitative conclusions.
- Not covered: Java, C#, Go and Rust dependency tooling, private-registry behaviour beyond reading `.npmrc`, and security of CI files beyond the GitHub guide.

## 2. What the domain is, today, in one paragraph

`verifyInSandbox` first runs `scanForSecrets` (five regexes plus an entropy rule on quoted strings of 24 or more characters), then `runSecurityGate`, which repeats the secret scan, applies about twenty line-by-line regexes to the whole new content of every file (Python rules only for `.py`), and checks `package.json` dependency names against 17 popular names by edit distance. Critical and High findings block. A block is a policy block: no repair, no escalation. The CLI's `--override <reason>` skips the gate for one run and writes a row to an `override_audits` table. Separately, untrusted text on the way to a model passes `injection.ts` (fold, strip hidden characters, match about twenty phrases, decode base64), and prompts wrap it in random delimiters. Dependency checks (`checkVersionPinning`, `runVulnScan`, pip-audit) run only when someone calls `purix audit`. The trust gate adds human confirmation when the classifier flags injection, a test was weakened, no related test exists, confidence is low, the run had no isolation, or the contract changed.

## 3. The tasks and their concepts

Seven tasks. For quality bars I use two numbers that are mine, marked as such: recall measured per claimed class, and an effective false-positive rate under 10%, the figure Google's Tricorder kept (primary, `PURIX-RESEARCH-02`).

---

## Task 1. Decide what the checks look at

### 1.1 Which lines of a file are judged

**Today.** `runSecurityGate` splits each file's full new content into lines. It does not look at the old content. Measured: a file with `exec(cmd, cb)` already in it plus a one-line version bump is blocked.

**What it should do.** Block what the change introduces. Semgrep's own documentation describes diff-aware scanning for this reason (cited in `PURIX-RESEARCH-02`).

**Quality bar.** An unrelated edit to a file with an old finding passes, and says "pre-existing finding, not blocking". A finding the change introduces, including one produced by moving lines, blocks.

**Cost and scale.** Time follows the size of the changed files (read, measured: 173 ms for 16.6 MB). Scanning the old content too doubles that, and the old result can be cached by content hash. Disk and network: none. A large repository changes nothing because only changed files are read.

**Large-repo bar.** Same bar, with a pre-existing backlog of findings in legacy files that must not block every agent edit. This is the common state of a large codebase.

| Option | Evidence | Weakness |
|---|---|---|
| A. Whole new file (today) | Measured | Old findings block new edits; pushes people to override |
| B. Added or changed lines only | Old content is available to the caller | A multi-line construct is cut in half and missed |
| C. Scan old and new whole files; block only findings that are new by rule and normalised text | Same idea as a baseline in Semgrep and CodeQL diff modes | Twice the scan work; a moved line must compare equal after normalising |
| D. C plus parsing, so a finding is tied to the function it sits in | More precise | Needs a parser per language |

**Best way.** C. It keeps full-file context for multi-line forms and blocks only new findings. Pre-existing findings are reported as advisory. Tier: T1. For a company the same code applies, with a stored baseline per repository as a configuration option. **One concept is enough.**

**How we would know.** The probe "old finding plus unrelated edit" passes, the probe "edit that moves the old finding" still reports it, and the false-block share on a real repository corpus falls.

### 1.2 Which files, and which language each rule applies to

**Today.** The JavaScript rules run on every file, whatever its type (measured: a `README.md` example is blocked). Python rules run only on `.py`. Secrets are scanned in every file. Nothing is scanned for Go, Java, C#, shell, Dockerfile, YAML workflows, `.npmrc`, `package.json` scripts or agent configuration files. A file type with no rules is silently treated as clean.

**What it should do.** Apply rules by file type, say which files were not scanned, and cover the non-code files agents write that run with the developer's authority. GitHub's guide describes script injection from `github.event.*` values in workflows and recommends pinning actions to a full commit SHA. The vault's ADR-062 says a skipped check is "not verified", never green.

**Quality bar.** Every changed file is reported as scanned by named rules, or as "not scanned: type".

**Cost and scale.** Dispatch by extension is free. Each added rule pack adds time that follows the change (expected). Per language, rule maintenance is a continuing cost (ADR-009 says so).

**Large-repo bar.** A repository mixing five languages and generated files must not hit false blocks on generated or vendored paths; an exclude list per repository is part of the bar.

| Option | Evidence | Weakness |
|---|---|---|
| A. Every rule on every file (today) | Measured | False blocks in docs and tests; unknown types look clean |
| B. Rules dispatched through the `LanguageProvider`; unknown types reported as not scanned | ADR-017 already has the provider; ADR-062 vocabulary | A new provider hook; each language needs its own rules |
| C. Small deterministic checkers for the highest-risk non-code files | GitHub Actions guide; Snyk lockfile post; Shai-Hulud account | More files to maintain |
| D. An AST engine with community rule packs for the code languages (Opengrep, LGPL-2.1, 30+ languages; Bandit, Apache-2.0, Python) | Primary READMEs | Not run by me; licence and rules licence need care (concept 2.1) |

**Best way.** B and C together, with D as the engine for code (concept 2.1). C is five small checkers: `package.json` scripts and sources, workflow files, Dockerfiles, `.npmrc` and registry settings, and agent or MCP configuration files. **A combination reaches the bar.** Tier: T1.

**How we would know.** The probe set for workflows, Dockerfiles, install scripts and git dependencies is caught, and a change that touches an unsupported type prints "not scanned".

**Verdict for Task 1.** A combination reaches the bar.

---

## Task 2. Find vulnerable code

### 2.1 The detection engine

**Today.** Line regexes (`security_gate.ts`). Measured on 42 dangerous probes: 5 blocked. Missed shapes: calls split over lines, aliased imports (`import { exec as run }`), indirect eval, `setTimeout` with a string, two-step environment exfiltration, reading `~/.ssh` and posting it, DNS exfiltration, path traversal, SSRF, `innerHTML`, `Math.random` tokens, disabled TLS verification, prototype pollution, `jwt.decode`, multi-line Python subprocess and SQL, `pickle.load`, `verify=False`, and code in Go, Java, shell, a Dockerfile and a workflow. One catch was accidental: a malicious `postinstall` string in `package.json` was caught only because `process.env` and `https.get` appear in the text.

**What it should do.** Detect the classes it claims, at a measured rate, with few false blocks. The sources set the size of the problem: Veracode found 45% of 80 tasks across over 100 models produced a vulnerability, with XSS failing in 86% and log injection in 88% (vendor-run). Pearce and others found about 40% of 1,689 Copilot programs vulnerable (peer-reviewed, 2022). The CWE Top 25 for 2025 puts XSS (CWE-79), SQL injection (89), CSRF (352), missing authorization (862), path traversal (22), OS command injection (78) and code injection (94) near the top, and also lists SSRF (918) and deserialization (502).

**Quality bar.** For each class Purix claims, a published test set of vulnerable and safe pairs shows recall and false-positive rate per class. Purix claims only classes with recall at or above 80% (my number) and effective false positives under 10% (Tricorder). Everything else is labelled "not checked".

**Cost and scale.** Regex rules: linear in the change, but quadratic on a crafted single line (measured: 43 s at 600 KB, concept 2.3). Single-file AST rules: parse plus match, expected to be seconds, not run by me. Cross-file taint needs a database or graph of the whole project, which grows with the repository (CodeQL overlay mode is "up to 10x" faster than a full run, per its documentation, as cited in `PURIX-RESEARCH-02`). A model reviewer costs tokens and seconds per change and is not deterministic.

**Large-repo bar.** The per-change tier must not scale with the repository. Whole-repository analysis runs in the background or in CI.

| Option | Evidence | Weakness |
|---|---|---|
| A. Line regexes (today) | Measured: 5 of 42 | Misses multi-line and indirect forms; false blocks on text that only mentions a call; quadratic on crafted input |
| B. AST pattern engine, single file (Opengrep or Semgrep CE; Bandit for Python) | Semgrep CE analyses one file and one function at a time (primary); Opengrep adds intra-file taint, LGPL-2.1 | Not run by me; Semgrep-maintained rules are under the Semgrep Rules License v1.0, "not an open source license", with no use in competing products or SaaS (primary); Opengrep rules and coverage per class unmeasured |
| C. Cross-file taint (CodeQL; Semgrep Pro) | Finds flows across functions | CodeQL licence allows automated analysis of private code only with a paid GitHub Advanced Security licence and bars third-party bundling (primary); heavy |
| D. A model reviews the diff | Already in the pipeline | Non-deterministic, costs tokens, can itself be steered by injected text; may only raise a flag |
| E. Consume the company's own SAST results (SARIF) at merge time | ADR-009's own revisit trigger names a plugin interface | Needs the company to have one; arrives late |

**Best way.** A cascade, cheapest first, as the sufficiency rule asks. A (fixed: linear time, masked comments and strings) at T1 for the few classes where one line is enough. B through the tool broker at T2 (a separately installed, hash-pinned binary, as pip-audit is today, so the engine is not linked into Purix), with rule packs Purix owns or whose licence allows use. D at T3 as advice that can only raise scrutiny, never clear a finding. E at T4 for companies. C is reachable only through E. **The bar costs too much for full coverage in the interactive tiers, so the task changes: narrow the claim.** The product says "single-function patterns for these classes checked; cross-file flows checked only if your SAST ran", and moves deeper analysis to T3 and T4.

**How we would know.** Per-class recall and false-positive rate on a public test set (for example the OWASP Benchmark or Juliet, which I did not open) plus a corpus drawn from real repositories. The 42-probe set becomes a regression test. Timing per tier on the 1k, 10k and 100k benchmark from `PURIX-RESEARCH-02`.

### 2.2 Which classes are covered

**Today.** Rules exist for SQL injection (CWE-89, one line), command and code injection (78, 94, partly), unsafe evaluation and deserialization (94, 502, partly), weak hashes (327), whole-environment exfiltration, and secrets (798). ADR-009 also lists "missing authorization checks on new routes"; I found no such rule. There is none for 79, 22, 862, 918, 352, TLS verification, insecure randomness or SSRF.

**What it should do.** Claim a class only when a rule, a test set and a measured rate exist. Missing authorization is hard to find with patterns (framework-specific), so it is a candidate for "not checked" plus an explicit label.

**Quality bar, cost, large-repo bar.** As 2.1.

**Best way.** Add classes in order of how much generated code gets them wrong and how well a single-function pattern can find them: XSS sinks, path traversal and SSRF through the engine in 2.1, TLS verification off and `verify=False`, insecure randomness for tokens. Leave 862 and 352 as labelled "not checked" until framework-aware rules exist. **One concept is enough** (the rule inventory follows the engine).

**How we would know.** The claim list in the product equals the list of classes with a published measured rate.

### 2.3 The rules must not be a way to stall or flood the pipeline

**Today.** Measured in isolation: 16.6 MB of normal code in 173 ms; a single 600 KB line of repeated `exec(` in 43 s; `query('` repeats in 5.6 s at 340 KB. The cause is regex backtracking in the shell-call and SQL rules. The injection scan costs about 0.6 s per MB of text (4.5 MB in 2.9 s), linear in my test; memory was not measured. At 5 to 15 false blocks per 100 legitimate edits (concept 1.1 and 1.2) the gate also floods people with overrides.

**What it should do.** Bounded time per file on any input, and a result "could not scan: too long" that is not a pass and not a code failure, matching `PURIX-RESEARCH-02`'s rule that infrastructure results never enter repair.

**Quality bar.** Any input of up to the largest accepted change size scans within a fixed budget, and exceeds it only to return "not scanned".

**Cost and scale.** One compiled-regex pass costs a few milliseconds per file; a line-length cap plus linear-time patterns keeps the worst case linear. A 30-second stall also loses the repository lock (`PURIX-RESEARCH-02`, finding 4).

| Option | Evidence | Weakness |
|---|---|---|
| A. No bound (today) | Measured | Crafted input freezes the CLI and can free the lock |
| B. Skip lines above a length (minified bundles are not reviewed by eye anyway) and report them as "not scanned" | Simple | Attackers put payloads on long lines, so these files must go to a human, not pass |
| C. Rewrite the two rules without nested unbounded repeats | Removes the quadratic cause | Needs the 42-probe set so behaviour does not change |
| D. Run the scan in a worker thread with a deadline | Node supports it; fits `PURIX-RESEARCH-02` task 1 | Larger change |

**Best way.** C and B together, D with the deadline work in `PURIX-RESEARCH-02` task 1. **A combination reaches the bar.**

**How we would know.** The crafted-line probes finish in under a second, and the 42-probe results do not change.

**Verdict for Task 2.** The bar costs too much for full coverage in line, so the task changes: a cheap cascade with a narrower, measured claim.

---

## Task 3. Dependencies and the supply chain

The sandbox links the existing `node_modules` and does not install, so a new dependency's install script cannot run during verification. The danger comes later, when the developer or an agent runs `npm install` after Purix has landed the manifest change. The check therefore belongs on the manifest and lockfile change, before the write. This follows from `sandbox.ts` and is an inference, since I did not read every install path.

### 3.1 Does the new dependency exist, and when was it first published

**Today.** Nothing checks. A made-up name passes the gate (measured). Evidence on size: across 16 models and 576,000 samples, at least 5.2% (commercial) and 21.7% (open-source) of suggested packages did not exist, with 205,474 unique hallucinated names. About 43% of hallucinated names reappeared in all 10 reruns of the same prompt and 58% in more than one, and about 9.6% were real packages in another ecosystem (arXiv 2406.10279, to appear at USENIX Security 2025). The authors did not register the names; they note an attacker could.

**What it should do.** Resolve each name a change adds against the project's own registry, and report a name that does not exist, was first published inside a cooldown window, or has an unusually thin history. Cooldown defaults in the field: pnpm's `minimumReleaseAge` default is 1 day (primary doc), and OpenSSF reports that most malicious packages are classified within 3 days (via an OpenSSF article). npm has a `min-release-age` setting, default unset (primary). My default is 7 days (mine, grounded in those two).

**Quality bar.** Every dependency name added by a change has a recorded verdict: exists or not, first publish date, and whether it sits inside the cooldown. A lookup that fails reports "not checked".

**Cost and scale.** One registry call per new name. Measured from this workspace: npm 46 to 189 ms, PyPI 81 to 126 ms per name. Cost follows the number of new dependencies in the change, not the repository. It is a network call, so it belongs in T2, uses the project's own registry settings (`.npmrc`, an Artifactory proxy), and is cached by name and version with an expiry. ADR-009 says no network in the gate path; that sentence was written for the CVE database, and the install will contact the same registry anyway, but it is a decision the person should ratify (section 6).

**Large-repo bar.** Same, behind a company registry proxy. A change adding ten dependencies must not cost more than about a second (my target, from Nielsen's limits cited in `PURIX-RESEARCH-02`).

| Option | Evidence | Weakness |
|---|---|---|
| A. No check (today) | Measured | Misses invented names, the central slopsquatting case |
| B. Existence, first-publish date, version count through the registry API | Measured latency; the registry returns `time.created` | Existence alone is not safety: `lodahs` exists on npm (created 2019, one version) and I did not check what it is |
| C. B plus weekly downloads and repository link | Common practice | Downloads and links can be inflated; the downloads endpoint was not tested |
| D. A local snapshot of known names | Works offline, no per-change call | Large, stale, and a new real package looks nonexistent |
| E. Look up the name in malicious-package records (OpenSSF, via OSV `MAL-` identifiers) | OpenSSF article; one record read (`expertsvc-onboard-offboard`, npm, reported by Amazon Inspector and OpenSSF Package Analysis) | The API was unreachable from here, so untested; records arrive within days, not hours |
| F. Ask the model whether the package is real | None | A model that hallucinated the name will vouch for it |

**Best way.** B, with E added at T2, C optional, and D only for air-gapped profiles. A failed lookup says "not checked". **A combination reaches the bar.**

**How we would know.** The invented-name probes are reported; a real, old package passes; a dependency published an hour ago is reported inside the cooldown; with the registry unreachable the result says "not checked".

### 3.2 Names that look like popular names

**Today.** Edit distance of 1 or 2 against 17 hard-coded names, names of 4 or more characters only, over every dependency in the file. Measured false blocks: `vite` against `vitest`, `tsup` against `tsx`. Caught: `lodahs`. The check does not apply to optional dependencies, to `requirements.txt` or to `pyproject.toml` (measured: `reqeusts` passes). It has no allow-list, though ADR-009 requires a per-repository one.

**What it should do.** Treat similarity as one signal about a new name, weighed with age and popularity, not as a block by itself.

**Quality bar.** A real popular package never blocks on similarity alone, and a young name close to a very popular one is always reported.

**Cost and scale.** Comparing one new name against a list of N names costs N small edit distances (expected: negligible for a few thousand). The list size is the lever: 17 names produces both the false blocks and the gaps.

| Option | Evidence | Weakness |
|---|---|---|
| A. 17 names, whole file (today) | Measured | False blocks; narrow |
| B. Added names only, plus a per-repository allow-list (ADR-009) | ADR-009 | Still blocks on similarity alone |
| C. Similarity counts only when the name is young or rarely used (uses 3.1's data) | Combines two signals | Needs 3.1 first |
| D. A larger popular-package list from registry statistics | Better coverage | I did not find a primary source for such a list |

**Best way.** B and C. **A combination reaches the bar.** Tier T2.

**How we would know.** `vite` and `tsup` pass; a young name two edits from `lodash` is reported.

### 3.3 Where the dependency comes from, and what runs at install

**Today.** Not checked. Measured misses: a `postinstall` script, a `github:` dependency and a tarball URL. `checkVersionPinning` flags `^`, `~`, `*` and `latest` only, and only when `purix audit` is run.

**What it should do.** Flag dependencies that bypass the registry and changes that add install-time code or redirect the registry. Evidence: GitHub reports that the Shai-Hulud worm spread by compromising maintainer accounts and injecting malicious post-install scripts, and that more than 500 compromised packages were removed (primary, dated 2025-09-22). The 2019 lockfile-injection proof of concept changed only one lockfile entry's source to an attacker repository, and reviewers missed it because lockfile diffs are collapsed and unread (vendor-run, Snyk). pnpm disables dependency lifecycle scripts by default since version 10 and offers `blockExoticSubdeps` and `trustPolicy` (primary page, partly summarised). Purix's own broker already installs with `--ignore-scripts` from a hash-checked lock.

**Quality bar.** A change that adds a git, URL or path dependency, edits an install-time script, changes the registry, or changes a lockfile `resolved` host or integrity value is reported, whatever its size.

**Cost and scale.** Parsing the changed manifest and diffing lockfile entries. Cost follows the lockfile size once per change (expected: a large monorepo lockfile is several megabytes; not measured), and can be kept flat by diffing entries.

**Large-repo bar.** Same, with lockfile churn from many developers; only entries added or changed since the base need a verdict.

| Option | Evidence | Weakness |
|---|---|---|
| A. Not checked (today) | Measured | Misses the install-time and source attacks |
| B. Deterministic rules on the manifest and lockfile diff (non-registry sources, scripts, registry changes, new `resolved` hosts) | Snyk and GitHub accounts | A list of allowed hosts per repository |
| C. Report whether the project's package manager enforces scripts off and a release-age rule (`purix status`) | pnpm and npm documentation | Purix reports, it does not enforce |
| D. Verify tarball integrity and provenance | npm provenance exists | Not researched in depth; coverage uneven |

**Best way.** B at T1, C in `purix status`, D later. **A combination reaches the bar.**

**How we would know.** The three probes are blocked, and the 2019 pattern (one lockfile entry moved to an off-registry host) is reported.

### 3.4 Known-vulnerable and known-malicious versions

**Today.** `runVulnScan` runs the project's own `pnpm audit`, `yarn audit` or `npm audit` with `--json` and parses the result. Measured: false clean for pnpm 10, pnpm 11 and Yarn 4 (finding 1). JFrog reports that npm's legacy audit endpoints were retired on 2026-07-15 and that older clients get HTTP 410 (vendor notice); pnpm 11 moved to the bulk advisory endpoint. I saw working output from pnpm 10.34.7 and 11.28.6 against the live registry, so my runs did not hit the 410 error. The existing test file has one test (pinning only), and I found no recorded real output for any package manager in the tests. The Python path is better: pip-audit with the OSV service, `ran: false` unless a real report came back, but only for `requirements.txt`, and the sandbox denies the network it needs.

**What it should do.** On a change that adds or raises a version, report advisories and malicious-package records for exactly those versions, say "not checked" otherwise, and run a whole-tree audit on a schedule. OSV-Scanner (Apache-2.0) reads 19 or more lockfile types and has an experimental offline mode using a downloaded database (primary README and page); I could not confirm from the README whether it reads `pnpm-lock.yaml` and `requirements.txt`.

**Quality bar.** A change that adds `lodash@4.17.15` is reported with its advisory ids on every supported package manager, and an audit that could not run is "not checked" on every package manager.

**Cost and scale.** Querying only the changed (name, version) pairs follows the change. A full-tree audit follows the whole dependency tree (a large monorepo can hold thousands of entries) and belongs in T4. The offline database is a file per ecosystem; its size I did not find. Network: one call per change online, none offline.

**Large-repo bar.** Same, and the company's registry proxy may not expose an advisory endpoint, so the offline database matters.

| Option | Evidence | Weakness |
|---|---|---|
| A. The project's own `audit` command (today) | Measured: 6 of 6 npm and Yarn 1; 0 of 6 pnpm, Yarn 4 | Output shapes differ and change; not in the pipeline |
| B. A fail-closed parser: only an output matching a known shape counts as a scan | Fixes the false clean at once | Still depends on each tool's shape |
| C. OSV-Scanner on the lockfile (offline database or API) | Primary README | Coverage per lockfile unconfirmed; experimental offline flag |
| D. Query OSV directly for changed pairs | OpenSSF article documents `query` and `querybatch` | Untested by me; online only |
| E. A mirrored database with a staleness bound (ADR-009) | ADR-009 | 14 days is too stale for malicious packages, since most are classified within 3 days |

**Best way.** B immediately, with recorded real outputs from each tool version as test fixtures. For changed pairs, D online at T2 (also yields `MAL-` records, which covers 3.1's option E) with C offline as the fallback. A full-tree audit in T4. ADR-009's staleness bound should be split: advisories may use 14 days, malicious-package data should not. **A combination reaches the bar.**

**How we would know.** The lodash fixture reports six advisories on npm, pnpm 10, pnpm 11, Yarn 1 and Yarn 4; a broken or empty output reports "not checked".

### 3.5 Other ecosystems and manifests

**Today.** Python: pinning check and pip-audit for `requirements.txt`; no `pyproject.toml`, `poetry.lock` or `uv.lock`; the gate checks nothing for Python dependencies (measured). Nothing for Go, Java or C#. I assumed in `PURIX-RESEARCH-02` that large companies use Java, C# and Go; I did not research that.

**What it should do.** Turn every manifest and lockfile into (ecosystem, name, version, source) tuples once, then apply 3.1 to 3.4 to the tuples, since OSV is ecosystem-neutral and PyPI has the same kind of JSON endpoint (measured 81 to 126 ms).

| Option | Evidence | Weakness |
|---|---|---|
| A. TypeScript and Python only (today) | Read | Not enough for the target customer |
| B. A provider hook that returns tuples for changed manifests | Fits ADR-017 | One parser per ecosystem |
| C. Use OSV-Scanner's parsers | 19 or more lockfile types (README) | Dependency on one tool's coverage |

**Best way.** B for TypeScript and Python now, C for the rest. **A combination reaches the bar.** Not researched further: Maven, Gradle, NuGet, Go modules.

**How we would know.** The same four checks run on a `pyproject.toml` change.

**Verdict for Task 3.** A combination reaches the bar. It splits the work across tiers: T1 rules on manifest and lockfile diffs, T2 registry and advisory lookups for changed pairs, T4 the full audit.

---

## Task 4. Secrets

### 4.1 Detecting secrets in candidate content

**Today.** Five patterns (AWS access key, Google key, one private-key header form, bearer token, a key or secret assignment) and an entropy rule: a quoted string of 24 or more characters from `[A-Za-z0-9+/_-]` with Shannon entropy above 4.0. Measured on synthetic tokens: 9 of 22 caught. Caught: AWS key, a 40-character AWS secret, GitHub tokens (quoted), Slack, Stripe, OpenAI and Anthropic keys (quoted). Missed: GitHub token unquoted in YAML, GitHub and npm tokens in `.npmrc`, SendGrid and JWT (contain a dot), a 32-character hex key (hex entropy cannot exceed 4.0), a database URL with a password, a short quoted password, three PEM variants (`ENCRYPTED`, `DSA`, `PGP`), a key split by concatenation, a base64-encoded key. False flags on 3 of 13 ordinary strings: a long identifier in quotes, a small base64 image and a snapshot hash. Lockfile integrity strings, UUIDs, SHA-256 hex, import paths and i18n keys were not flagged.

**What it should do.** Match known token formats by prefix and structure, apply entropy only where an assignment context makes a secret likely, and read unquoted values in the file types that hold them.

**Quality bar.** Every format in the rule set is detected across quoted, unquoted, `.env`, YAML and `.npmrc` contexts in synthetic tests, and benign long strings are not flagged above the 10% effective false-positive bar. Obfuscated secrets are explicitly not promised.

**Cost and scale.** Linear in the changed content (read). A keyword prefilter before the regex, as gitleaks does, keeps it cheap. History scans are a CI job, not a per-change cost.

**Large-repo bar.** Same; a monorepo with many fixtures needs a path allow-list or baseline so that known test tokens do not block.

| Option | Evidence | Weakness |
|---|---|---|
| A. Five patterns plus quoted entropy (today) | Measured: 9 of 22, 3 of 13 false | Misses unquoted, dotted, hex, URLs; false flags |
| B. Port gitleaks' rules (MIT): regex, keyword prefilter, per-rule entropy, allowlists | gitleaks README | README says the tool is feature complete, security patches only, author moving to Betterleaks, so copy the rules, do not depend on the tool |
| C. TruffleHog (AGPL-3.0, over 800 secret types, 700 with live verification) | README | AGPL does not fit an Apache-2.0 product to bundle; verification sends the found secret to the provider's API, a leak path of its own |
| D. The host's push protection and secret scanning (GitHub) | Server-side | Outside Purix; only as a required check |
| E. Ask a model | None | Sends the secret to the model |

**Best way.** B's rule format, written as Purix's own rule set with prefilters and file-type contexts, with the entropy rule kept only for assignment contexts. C as an optional CI tool with live verification off by default. **A combination reaches the bar for known formats.** **The bar costs too much for obfuscated secrets, so the claim narrows:** "known formats and plain assignments; not split, encoded or generated secrets". The sandbox's network denial and the exfiltration rules (task 2) are the second layer.

**How we would know.** The 22-token probe set, rerun, catches all formats in all contexts; the 13 benign strings stay clean; recall per format is published.

### 4.2 What the person and the agent are told

**Today.** A secret is a policy block with no repair and no override (`sandbox.ts`). The message shows `redact()`: the first 4 and last 4 characters of any match longer than 8. For a 12-character secret that reveals 8 of its 12 characters, and the text goes to the terminal, the event log, and over MCP (where `scrubSecrets` runs on the response, and can only hide what its rules recognise).

**What it should do.** Report the rule name, file and line, and nothing from the value.

**Best way.** Print no characters of the value; if a reference is needed, a short hash. **One concept is enough.** Cost: none.

**How we would know.** A test asserts that no substring of the value of three or more characters appears in output.

### 4.3 Secrets already in the component, on their way to a model

**Today.** `scrubSecrets` runs on neighbour context in escalation, on MCP responses and on memory notes. I found no call on the classification and refine prompts, repair prompts or the escalation's failing-file block. Those carry the component's existing files, including any secret already committed.

**What it should do.** ADR-001 calls scrubbed escalation the one deliberate channel by which repository content leaves the machine, and ADR-003 words the promise around escalation. Classification sends repository content too. Either the ADR wording is narrower than the product's real behaviour, or the scrub is missing on those paths. This is for the person to ratify (section 6), not for me to settle.

**Quality bar.** Any text sent to a model provider has passed the same scrub, or the product says plainly which text is not scrubbed.

**Cost and scale.** One regex pass per prompt (expected: milliseconds), linear in the prompt. Tokens: the replacement placeholder is shorter than most secrets. A false-positive scrub (the base64 image) removes context the model may need, which is a reason to fix 4.1 first.

| Option | Weakness |
|---|---|
| A. Scrub only escalation neighbours (today) | Classification and repair prompts carry unscrubbed secrets |
| B. Scrub every outbound prompt block with one function | Needs 4.1's rule fixes first, or it replaces harmless strings |
| C. Block a model call when the component's existing files contain a secret | Safest, but stops work on legacy components |

**Best way.** B, with the list of scrubbed paths in `purix status`. **One concept is enough.**

**How we would know.** A component containing a planted token produces prompts, captured in a test, with the placeholder in place of the token on every call type.

**Verdict for Task 4.** A combination reaches the bar for known formats, and the claim narrows for obfuscated ones.

---

## Task 5. Untrusted text that reaches a model, and what a steered model can do

### 5.1 The phrase tripwire

**Today.** `injection.ts` folds text (accents, look-alike letters, zero-width characters, whitespace), matches about twenty phrases, scans decoded base64 runs, and returns hits. Measured: 7 of 18 probes caught (classic phrase, base64, zero-width split, Cyrillic look-alikes, hidden markdown comment, role marker, tool-call markup). Missed: paraphrases, a note aimed at a reviewer model, a task hijack in a docstring, string concatenation, JSON unicode escapes, HTML entities, ROT13, hex, Chinese, an instruction aimed at agents to run `curl | sh`, and a phrase broken across two comment lines. Flagged 3 of 5 legitimate texts: a security document quoting the phrase, the detector's own test, an operations note.

**What it should do.** Primary sources agree it cannot be a boundary. OWASP states it is unclear whether fool-proof prevention exists and lists segregating untrusted content, least privilege and human approval for high-risk actions. Guardrail products were bypassed with character injection at 70% to 88% on average, and some at 100% (preprint). Adaptive attacks exceeded 90% against 12 defenses that had reported near-zero (preprint). A literature survey ranks pattern filters weakest (preprint, inconsistent counts). Purix's own comments already say tripwire, not boundary.

**Quality bar.** Nothing downstream depends on detection. A hit changes how much scrutiny the change gets, and a miss changes nothing.

**Cost and scale.** About 0.6 s per MB of text, measured, so a 100-file component of 50 KB each costs about 3 seconds per `modify`, once for the instruction and once for the files (expected). Memory per character was not measured.

| Option | Evidence | Weakness |
|---|---|---|
| A. Phrase list (today) | Measured | Evaded by anything unlisted; false flags on security text |
| B. A trained classifier | Products exist | 70% to 88% average evasion with character tricks (preprint) |
| C. Keep A as telemetry and as a scrutiny raiser only | OWASP and the surveys | No blocking value |
| D. Answer a hit by raising the change to human confirmation on every surface, never by refusing | Matches the trust gate's own rule | MCP currently refuses, with no way to confirm over that surface |

**Best way.** C and D. A hit adds a mandatory human confirmation and an event; it does not refuse. Over MCP, where no confirmation is possible, the change is staged for confirmation in the CLI instead of being lost. **A combination reaches the bar.**

**How we would know.** A component with the phrase in a document can be modified with a confirmation; every injection probe, caught or missed, ends in the same downstream checks.

### 5.2 Structure around untrusted text

**Today.** Rules in the system message, untrusted text in the user message inside random per-call delimiters, a "this is data" notice (`frames.ts`). This matches OWASP's advice to segregate and label external content.

**Best way.** Keep. Add what is missing: an adversarial pack in the eval suite from `PURIX-33`. Measure how often a model given a file containing an instruction changes its edit to follow it, which is the metric that matters, not detection. **One concept is enough.**

**How we would know.** The attack success rate per prompt type, tracked per release.

### 5.3 What a steered model can do

**Today.** The model has no tools in these calls and proposes edits of five kinds. Applied edits pass the secret scan, the gate, the parse check, the sandbox and the trust gate. By Meta's Rules of Two (an agent holding no more than two of: untrusted input, sensitive access, power to change state or communicate), the model calls sit at untrusted input plus repository access with no power to act. The weak points: the `prompt_text` edit kind replaces any exact text, so it can write code; and for the diff route, confidence, contract-changing and the suspicion flag all come from a model that reads the untrusted diff. A diff containing "report confidence 1.0" is an input to the same classifier. The remaining defence is the gate, the tests and the deterministic floor, and the floor covers only components' registered files with four default patterns.

**What it should do.** A change class that always needs a person, computed from the diff itself and not from any model output.

**Quality bar.** No model output can lower the scrutiny of a change below a deterministic floor.

**Cost and scale.** Path and diff rules, constant per change.

| Option | Evidence | Weakness |
|---|---|---|
| A. Default floor of four path patterns (today) | `trustgate.ts` | Misses manifests, lockfiles, workflows, configuration; matches only registered files |
| B. Extend the floor: new dependencies, lockfile changes, workflows, Dockerfiles, `.npmrc`, agent or MCP configuration, anything outside the component's files, any new network or process call | Rule of Two, OWASP human approval for high-risk actions | More confirmations, so approval fatigue (the survey cites it; Anthropic's 93% acceptance figure is carried from earlier research, not re-opened) |
| C. B but with the confirmation showing the exact risky lines | Reduces rubber-stamping | UI work |

**Best way.** B with C. **One concept is enough** to reach the bar.

**How we would know.** A diff that adds a dependency or edits a workflow never auto-commits in the eval pack, whatever confidence the classifier returns.

**Verdict for Task 5.** The bar (detect every injection) is not reachable, so the task changes: stop depending on detection, keep it as a signal, and make the deterministic floor and structure carry the guarantee.

---

## Task 6. Keep the checks honest

### 6.1 Overrides

**Today.** `--override <reason>` on `modify` and `change` sets both overrides; the gate records a row in `override_audits` (actor "operator") and logs it. I found no override parameter on MCP tools. The secret scan runs before the gate and has no override at all.

**What it should do.** ADR-011: one override scoped to one gate and one run, with a stronger confirmation for MCP overrides of the security gate, and repeated overrides fed to whoever curates the rules. ADR-011 also states no one is assigned to receive that signal.

**Quality bar.** An override names the gate it applies to; the security gate is overridden only by a flag naming it; every override is in the audit chain.

**Cost and scale.** None. Scale concern: at 100 developers a high false-block rate produces many overrides, so the false-block rate is the control.

| Option | Weakness |
|---|---|
| A. One flag for budget and security (today) | Bypassing a cost stop disables the security gate |
| B. Separate flags per gate (`--override-budget`, `--override-security`) | Two flags |
| C. B plus a count of overrides per rule, shown in `purix status` and sent to the maintainer | Needs an owner for the rules |

**Best way.** B and C. **A combination reaches the bar.** Not traced: whether `override_audits` rows enter the audit chain.

**How we would know.** A test passes the budget flag and the security gate still blocks.

### 6.2 Rules need an owner and a corpus

**Today.** The golden corpus in `security_gate.ts` has four entries; a Python corpus exists in a test. ADR-009 requires a maintained known-vulnerable and known-safe corpus run as a CI regression gate, and its Confirmation section lists five items as not verified. The evasion test file is a good start (18 flagged and 12 clean cases).

**Best way.** Task 7. **One concept is enough.**

**Verdict for Task 6.** A combination reaches the bar.

---

## Task 7. Prove the checks work

**Today.** The gate tests cover the rules' own examples, including clean probes. I found no measured recall or false-positive rate for any rule, no real-repository corpus, and no test with recorded output from each package manager.

**What it should do.** Publish, per claim, the probe set, the recall and the false-positive rate, and rerun them in CI.

| Probe set | What it proves |
|---|---|
| The 42 dangerous and 8 legitimate code probes, grown per class | Per-class recall and false blocks |
| The 22 token and 13 benign-string probes | Secret recall and false flags |
| The 18 injection and 5 legitimate texts | Tripwire behaviour, as telemetry |
| Recorded audit output for every package manager and version | No false clean |
| Crafted-input timing set | No stall |
| A corpus of real repositories, with known pre-existing findings | False-block rate in the wild |

**Best way.** Build the six sets once; make the claim list in the product equal the list of classes with a measured rate. **A combination** (all six) is needed.

**How we would know.** The sets run in CI and a regression fails the build; the corpus has at least three repository sizes (`PURIX-RESEARCH-02` task 8).

**Verdict for Task 7.** A combination reaches the bar: all six sets are needed, and none replaces another.

---

## 4. How the picks fit together

Tiers follow `PURIX-RESEARCH-02`.

- **T0 (hook).** Nothing here.
- **T1 (under 2 s, local, deterministic).** Secret rules with prefilters; code rules in linear time on added findings only; rules for manifests, lockfiles, scripts, workflows, Dockerfiles, `.npmrc`; the deterministic floor; scan-bounded input. Result vocabulary: scanned, not scanned, could not scan.
- **T2 (under 10 s, with progress).** Registry existence and age for new names; advisory and malicious-package lookup for changed pairs; AST engine through the broker for single-function patterns.
- **T3 (background).** A model reviewer that can only raise a flag; heavier analysis; the dependents' dependency changes.
- **T4 (merge or schedule).** Full audit of the dependency tree; the company's SAST (SARIF); secret history scan; `purix check --strict`.

For one developer everything runs locally and T4 is absent. For a company the differences are features in profiles of the same codebase: the registry endpoint, a shared lookup cache, the baseline of pre-existing findings, the company's SAST input, the allow-list of registry hosts, and override reporting. Nothing here needs a second codebase.

## 5. What this document did not settle

- Detection rates of Opengrep, Bandit, gitleaks and TruffleHog on Purix's probes, and their start-up cost inside the broker.
- OSV live behaviour: latency, batch limits, `MAL-` coverage for pnpm and Python lockfiles, offline database size.
- A public benchmark for the code classes (OWASP Benchmark, Juliet), not opened.
- npm provenance and signature checking, PyPI attestations, dependency confusion on private names.
- Java, C#, Go and Rust toolchains.
- How CI wires the golden corpus, and whether override rows reach the audit chain.
- Real-repository false-block rates; all rates here come from my own probes.
- The effect of memory use of the injection fold on very large files.

## 6. Decisions the person should ratify

- **ADR-009.** Amend: findings reported on new lines only; a registry existence and age check on added names (network, using the project's registry); malicious-package data not subject to the 14-day bound; delete or implement the CVE mirror and the allow-list as written; narrow the stated scope to measured classes; mark "missing authorization" as not checked.
- **ADR-011.** Per-gate override flags; confirm that the absence of an MCP override is intended.
- **ADR-001 and ADR-003.** State which model calls carry unscrubbed repository text, or scrub them.
- **ADR-062.** Ratify, since findings 1 and 2 are breaches of its roll-up rule.
- **IDEA-069 and 019.** Promote to an ADR "dependency trust gate", using concepts 3.1 to 3.5.
- **docs/compliance.** Correct the vulnerability-scan and typosquat claims until findings 1 to 4 are fixed.

## 7. Corrections to earlier documents

- **`PURIX-RESEARCH-00`, section 5 item 4** (the gate is line-by-line, 17 typosquat names): confirmed. Add: the gate scans whole files and every file type with the JavaScript rules; a crafted line can stall it.
- **`PURIX-RESEARCH-02`, section 3** ("Security of generated code": gate and scan cost grows with the size of the change, "good at scale"): right for normal code, wrong for crafted input (finding 10). Its statement that `deps_audit.ts` was not read is superseded: it is read, and the scan is not in the pipeline.
- **`PURIX-RESEARCH-02`, section 3** ("A registry check would add a network call per new dependency (expected)"): measured at 46 to 189 ms per name (npm) and 81 to 126 ms (PyPI) from this workspace.
- **Handoff, section 11:** add findings 1 to 13 above.

## 8. Sources

**Primary**

- Spracklen and others, "We Have a Package for You!", arXiv 2406.10279 (abstract and full text; USENIX Security 2025).
- Pearce and others, "Asleep at the Keyboard?", arXiv 2108.09293 (abstract; IEEE S&P 2022).
- MITRE, 2025 CWE Top 25, `cwe.mitre.org`.
- OWASP GenAI, Top 10 for LLM Applications 2025 list and LLM01 page.
- Meta, "Agents Rule of Two", 2025-10-31.
- GitHub, "Our plan for a more secure npm supply chain", 2025-09-22; "Security hardening for GitHub Actions".
- pnpm, supply-chain security page (summarised); npm CLI config reference (`min-release-age`, `ignore-scripts`, `before`).
- Semgrep, Community Edition comparison page; Opengrep README; Bandit documentation; CodeQL CLI licence (`github/codeql-cli-binaries`).
- gitleaks and TruffleHog READMEs; OSV-Scanner README and offline-mode page; OpenSSF, "Detecting Malicious Packages using the OSV API"; OSV record MAL-2025-190585.
- Purix source code, vault ADRs and plans, `PURIX-RESEARCH-00`, `01`, `02`, the handoff.
- My own measurements (section 1), scripts in `research-03-experiments/`.

**Preprints (not peer reviewed as far as I could tell)**

- Hackett and others, guardrail evasion, arXiv 2504.11168.
- Nasr and others, "The Attacker Moves Second", arXiv 2510.09023.
- Liu and others, "Your AI, My Shell", arXiv 2509.22040 (abstract: up to 84% attack success on Copilot and Cursor).
- Maloyan and Namiot, prompt injection on coding assistants, arXiv 2601.17548 (inconsistent counts; qualitative use only).

**Vendor-run or secondary**

- Veracode, 2025 GenAI Code Security Report (press release; vendor-run).
- JFrog, npm legacy audit endpoints retired (vendor notice).
- Snyk, lockfile injection, 2019 (vendor-run).
- Datadog, GuardDog 3.0 (no detection numbers given).

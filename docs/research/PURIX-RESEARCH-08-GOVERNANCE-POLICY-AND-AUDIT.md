# PURIX Research 08: Governance, policy and audit

Number "08" is provisional. Rule C says the plan assigns numbers, and I did not find one for this domain, so please confirm or renumber.
Snapshot: code `@purix/core 0.3.0-beta.1` as uploaded, vault `purix-knowledge-working-2026-10-04`, date 2026-10-29.
Method: `PURIX-RESEARCH-METHOD-2026-10-29.md` plus Addendum B (M1 to M8). Evidence levels: A = run by me on the real code with repetitions, B = read in the code or a primary source, C = secondary source, D = reasoning only.

## 1. Answer first

The audit chain is sound for what it was built to catch (edited records, removed front records) and weak in four places that matter for a large company. Each was probed, not guessed.

1. **Concurrent writers fork the chain, and the verifier then calls it tampering.** 4 processes x 200 appends, 5 runs: every run forked (4, 4, 10, 12, 11 fork points) and `verify` reported "Broken prev_hash". A transaction around read and insert fixed it in 5 of 5 runs. Level A.
2. **Cutting records off the end is invisible without a git anchor.** 20 records, 5 deleted from the tail, verdict stayed valid with 15 records. The code says so; the evidence is that nothing else catches it. Level A.
3. **Override records are outside the chain.** Editing or deleting every `override_audits` row left the chain verdict valid. The one record a compliance reviewer asks for first is the least protected. Level A.
4. **The deterministic floor misses real cases.** A Windows path with backslashes, a differently cased `Auth` folder, and a nested `packages/x/src/security/` all miss. The defaults also do not cover CI workflows, CODEOWNERS, Dockerfiles, the Purix config or agent settings. Level A.

Two more are read from code (level B): the scheduled chain check never runs inside a short CLI command, and the auto-commit decision rests on the classifier's own confidence with no calibration (Anthropic's own published auto mode figures show why that is risky, section 5).

## 2. What exists today (level B, code read in full)

| Part | File | What it does | Honest limit |
|---|---|---|---|
| Trust decision | `gates/trustgate.ts` | Order: injection flag, weakened tests, no coverage, confidence below 0.35 abort, 0.75 or more and not contract-changing and isolation not "none" auto-commit, else human | Confidence is the classifier's own number. Coverage is a file-level yes/no |
| Deterministic floor | same | Path globs force a human. Default 4 patterns, overridable by `dof-patterns.json` | Matches only registered files in the request. No separator or case normalising |
| Audit chain | `security/audit_tamper_evidence.ts` | sha256 of `prev|timestamp|payload`, verify, prune with checkpoint | No transaction. Tail truncation undetected alone |
| Anchor | `evidence/anchor.ts` | `Purix-Evidence: sha256:<head>` commit trailer, verdicts anchored / not_anchored / failed | Needs the user to commit the trailer |
| Overrides | `security/override_audit.ts` | Plain table, reason required | Not chained |
| Approvals | `approvals/pending.ts` | HMAC signed, single use, 30 minute life | Same OS user can read the key (stated in the file). Decisions not written to the chain |
| Scheduler | `state/scheduler.ts` | Verify hourly, prune daily at 365 days | First poll is after 30 s. Failure only prints to stderr |
| Export | same chain file | HMAC signed JSON | Zero production callers |

Who writes to the chain today: model baseline, tool broker, drift, landed change. Gate decisions, overrides and approvals are not among them (grep, level B).

## 3. Tasks, concepts and the best way

Verdict words follow the method: ONE (one concept is enough), COMBO (a combination reaches the bar), CHANGE (the bar costs too much, so the task changes).

### Task G1. Keep the chain correct under many writers
Bar: a chain that two agents and a human can write at once never forks, never gives a false tamper alarm. Large repo: 100+ developers, many agent sessions.
| Option | Evidence | Weakness |
|---|---|---|
| Today, no lock | Level A: fails 5/5 | Forks, false alarms |
| `BEGIN IMMEDIATE` around read and insert (the store already has this helper and a 5 s busy timeout) | Level A: 5/5 clean, 801 rows each | Writers wait; test at 100k rows and a lock holder crash is not done |
| Add `UNIQUE(prev_hash)` as a second guard | Level D | Not tested |
| One chain per writer, merged later | Level D | Needs a merge rule, more to verify |
**Verdict ONE.** Wrap the append in a transaction, add the unique index on top. Appending 100,000 records took 21 s, about 0.2 ms each, so the cost is nowhere near the 100 ms hook tier (level A, single run, label: single-machine).

### Task G2. Prove nothing was cut from the end
Bar: a reviewer can show the chain was not shortened.
| Option | Evidence | Weakness |
|---|---|---|
| Git trailer anchor (today) | Level B | Only works if the trailer is committed and pushed |
| Make the anchor automatic on every landed change | Level D | Needs a decision on commit flow |
| Signed checkpoints sent outside the machine (RFC 3161 timestamp, or a transparency log such as Rekor) | Level C/B: Rekor documents an append-only log monitored for consistency; I could not read the RFC 3161 text (fetch blocked, level D for details) | Network dependence, cost, privacy of what is sent (send only the head hash) |
**Verdict COMBO.** Automatic git anchor as the default (free, offline), plus an optional external timestamp of the head hash for the large-company profile. The AIVS draft (individual submission, not a standard) lists these same two as optional extensions, so there is no standard that makes either mandatory (level B, read in full).

### Task G3. Put overrides and approvals in the same protected record
Bar: every override and every approve or deny is tamper-evident and names who did it.
| Option | Evidence | Weakness |
|---|---|---|
| Today: separate table | Level A: edit and delete go unnoticed | |
| Write each override and decision as a chain record (the chain already takes any object) | Level D, small change | The chain payload needs a fixed schema |
**Verdict ONE.** Add a `kind: "override"` and `kind: "approval"` chain record, keep the table as a view. Record: actor, human or agent, gate, reason, policy version, decision, run id. Also record the gate decision itself, not only the override, so a reviewer sees what the gate said.

### Task G4. Decide what may auto-commit
Bar: a measured, low rate of bad changes reaching the repo unreviewed.
| Option | Evidence | Weakness |
|---|---|---|
| Classifier confidence at or above 0.75 (today) | Level B | The score is model-reported. ADR-007 names a golden-set check but no number; the test file checks 3 fixtures and compares a fixture to itself, so it does not measure the scorer (level B) |
| Anthropic auto mode style classifier | Level B (primary page, read) | Published full pipeline: false negative 17% on real overeager actions (n=52), 5.7% on synthetic exfiltration (n=1,000); users accept 93% of manual prompts anyway |
| Deterministic floor widened, plus human on everything it hits | Level A for the matcher | Only as good as the pattern list |
| Evidence-based rule: auto-commit only when verification passed in isolation, tests cover the change and the floor is clear, confidence as a tie-breaker | Level D | Needs the measurements from documents 04 and 06 |
**Verdict COMBO.** Floor first, then verification evidence, then confidence as one input. Do not claim a safety rate for the 0.75 threshold until the golden set has real cases and a number. Anthropic's 17% shows even a strong classifier misses a meaningful share; n=52 is small, so treat it as a direction (M3).

### Task G5. Make the floor catch what a large company cares about
Bar: the paths a security team would name are covered on every OS.
Probe results (level A, 21 paths): hit: `src/auth/`, migrations, `.env*`, `src/security/`, also `src/notauth/` (over-match, safe direction). Miss: backslash path, `Auth` casing, `packages/x/src/security/`, `authz`, `iam`, `.github/workflows`, `Dockerfile`, `CODEOWNERS`, `purix.config.json`, `.claude/settings.json`.
**Verdict ONE.** Normalise separators and case before matching, make `src/security/**` into `**/security/**`, and ship a larger default list with an enterprise policy file. Also run the floor on every changed file in the diff, not only registered components (not checked: see section 6).

### Task G6. Know quickly when the chain is broken
Bar: a failure is seen by a person within a short time.
Today: the check runs when the scheduler ticks, which is after 30 s, so a normal CLI command never triggers it; only the long-running MCP server does (level B). Failure goes to stderr.
**Verdict COMBO.** Verify on `purix status` and before every merge or evidence export (cost: 100,000 records verified in 0.37 to 0.45 s, 5 runs, level A), and write the result to the status output and the PR report. Past about 1M records, verify from the last checkpoint.

### Task G7. Retention, export and mapping to rules
Today 365 days by default (ADR-037), export dormant, enterprise reporting not built (ADR-038, correctly deferred until a real deal).
Sources (primary, read): EU AI Act Article 12 requires high-risk AI systems to allow automatic recording of events over their lifetime; paragraph 3 detail applies to remote biometric systems only. So Article 12 does not directly bind a coding governance layer unless the customer's system is high-risk. Article 26(6) log retention and ISO 42001 and SOC 2 were not opened: **primary not opened**, claims about them are level C or D. NIST SP 800-218A final (26 July 2024) is the SSDF profile for AI; the page read says nothing on logging, the PDF was not read.
**Verdict CHANGE.** Do not build a compliance product now. Build the record (G1 to G3) and a plain JSON export with a signing key that the customer supplies. That already satisfies a procurement reviewer asking "can I get the logs".

## 4. What Purix must do, in order

1. Fix the append (transaction plus unique index). Small, testable, removes false alarms.
2. Chain overrides, approvals and gate decisions with a fixed record schema including policy version and human or agent identity.
3. Automatic git anchor on landed changes; optional external timestamp of the head.
4. Floor: normalise paths, widen defaults, enterprise policy file, test on Windows first (ADR-064 rule 4).
5. Verify on status, merge and export; surface failures in the PR report.
6. Build the golden set with real cases and a number before saying anything about the 0.75 threshold.
7. Wire export with a customer-held key; keep the compliance dashboard deferred.

## 5. Sources and read depth

| Source | Read depth | Used for |
|---|---|---|
| Anthropic engineering, Claude Code auto mode | Read, fetched page | 93% acceptance, classifier error rates |
| EU AI Act Art. 12 (Commission service desk) | Read, article text | Logging duty scope |
| IETF draft-stone-aivs-01 | Read, full | Chain design, no mandatory anchoring, no tail check |
| Sigstore docs, logging overview | Read, short page | Append-only log monitoring; inclusion proofs not described there |
| NIST SP 800-218A page | Abstract page only | Existence and date |
| RFC 3161 | Not opened (fetch blocked) | |
| CIO.com opinion piece, ibl.ai post | Read, secondary | Not used for claims; neither is first-hand |
Large-company requirement (M5): **not met.** The two items I found were commentary and a vendor post, neither first-hand (M6). A real report from a large organisation on agent approvals is still needed.

## 6. What I could not check

- Whether the `events` log is hash-chained, and whether the MCP server writes the same events as the CLI.
- The floor on files in a diff that are not registered components.
- The transaction fix inside the product with `UNIQUE(prev_hash)`; I tested the append logic in a script only.
- Behaviour at 1M records, lock holder crash, Windows, network file systems.
- ADRs 004 and 018 implementation; ADR vault is older than the code.
- Rule B (a different session re-running the top three) has not happened.

## 7. Gate table (rule A)

| Gate | Done | Where |
|---|---|---|
| 0 snapshot pinned | yes, section header | |
| 1 protocol before searching | yes, `PROTOCOL.md` | note: written after the first probes (see PROTOCOL) |
| 2 read depth | yes, section 5 | |
| 3 claims register | yes, `claims-08.json` | |
| 4 run behaviour | yes | `probes/`, `raw/` |
| 5 repeated measurement | 5 reps for fork and fix and verify; single run for append cost | `raw/` |
| 6 try to break top findings | partly: fix tested, no one tried to disprove the fork | Rule B pending |

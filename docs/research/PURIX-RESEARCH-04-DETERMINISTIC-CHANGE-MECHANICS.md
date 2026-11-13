# Domain research 04: deterministic change mechanics

## Verification update, 2026-10-31 (method v2)

**Status under method v2: Unverified (no experiment folder, no protocol file, no claims register).** Pins: code `packages__2_.zip` d873c00c78b6822c; vault `purix-knowledge-working-2026-10-04.zip` 483002fb893b0085 (declared current by the owner on 2026-10-31, refresh after domain 16); Linux, Node 22.22.2; one run each. Full detail: `PURIX-RESEARCH-VERIFICATION-04-07-2026-10-31.md`. Probes: `research-verify-experiments/`. No finding below was deleted.

**Re-run results.**

| Finding | Result |
|---|---|
| 1, added file cannot be written | Confirmed. `applyModificationFiles` on a new path fails with ENOENT before any write. |
| 7, no write-time unchanged check | Confirmed, with a caveat: I simulated the gap through the writer's test hook (`writeFileImpl`), so this shows no check exists, not how likely the window is. |
| 9, `config_value` edits wrong text | Confirmed. Key `retry1`, old value `1`, new value `9` gave `retry9: 1` (key edited, value untouched). A comment `# port: 80 is default` above `port: 90`, asked to change 80 to 81, became `# port: 81 is default` with success reported. Same key and value on two lines was refused as ambiguous. |
| 2 to 6, 8 | Not re-run. They need the 1,018-file commit corpus and a process kill between writes. Not in the upload. |

**Dependency to record.** Finding 1 makes finding 2 unobservable until the writer creates files. Fix 1 before 2.

**Missing for "settled with gaps".** `research-04-experiments/`, a frozen protocol file, a claims register. Rebuilding the experiments from the section 7 and appendix descriptions is the first task of the next pass.

Prepared 2026-10-29. Status: **settled with gaps**. Snapshot: code `packages__2_.zip` sha-256 d873c00c78b6822c; vault `purix-knowledge-working-2026-10-04.zip` 483002fb893b0085 (older than the code; no finding below rests on an ADR, so the vault check is not needed for this document); Linux, 1 CPU, 4.2 GB, Node v22.22.2; Windows not tested. The protocol was written before any search or run and is in `research-04-experiments/PROTOCOL.md`. Scripts and raw output are in the same folder.

This domain covers what happens between "a change has been decided" and "the change is on disk and recorded": turning edits or a diff into new file contents, the scope of a change, formatting, repeat application, the write step and crash recovery. Edit formats themselves (what the model is asked to emit) are not redone; the AI research covers them.

## Consolidation notes, 2026-10-29

**Number.** Document 04 in the sequence 00 to 06. The method document and the earlier handoff reserved 04 for verification and test trust; that document is now 06.

**Checked again against the code zip by the consolidation session (read only, nothing re-run).** C1 holds: `applyModificationFiles` starts every change with `readFile(fullPath)` on the target path (`entrypoints/modify.ts`, line 59), so a new path throws. C3 holds: source files are written with `writeFile` and rolled back with `writeFile` (same file, lines 70, 90 and 116). C6 holds: key and old value are matched with `line.includes(...)` (`verify/compile.ts`, lines 56 and 62). `state/drift.ts` compares the live hash with `last_synced_hash` (`checkDrift`, line 29 onward). Where it is called was not traced here, and no second call at write time was found in the greps behind this document.

**A gap closed.** `state/idempotency.ts` was not read in the first pass. It stores a key made from the component, the normalised instruction text and the file-state hash, and it records the version that request produced. It stops the same request being committed twice. It does not stop a text edit whose new text contains its old text from being applied again to an already-changed file, because a second application changes the file hash and therefore the key. Task 6's finding about `x = 1` stands; the gap note in section 5 is closed for this file only (read, not run).

**Corrections inside this document.** Section 1 says experiments E1 to E7 were run; the earlier handoff said E1 to E6. E7 is the config-value run. The raw output and scripts folder `research-04-experiments/` was not part of the upload, so none of E1 to E7 could be re-run or re-read here; the protocol file was. Re-upload the folder before the fixes are built (plan, step "Files to re-supply").

**Boundary with the state-integrity domain.** Task 7 here already covers the write step, the read-to-write window and crash recovery. The later state-integrity domain therefore shrinks to the repository lock (takeover after about 30 to 38 seconds, merge conflicts in the committed lock file with many developers, lock refresh cost) and to the library chain from document 05.

**Evidence levels.** Each pick states its level in the text. Level B means measured by us (one machine, one run unless said); level C and D picks are marked "not yet shown to improve results" and name their experiment.

## 0. Read this first

**What this domain is for.** Take a decided change, produce the exact new file contents without guessing, and put them on disk so that either the whole change lands or none of it does. It has two jobs: computing the new contents (anchors, AST transforms, diff apply) and landing them (write, record, recover).

**Findings that matter most**

1. **A diff that adds a file cannot be written.** `applyModificationFiles` reads each file's old content first, so a new path fails with ENOENT before anything is written (measured, E1). Both entry points, the CLI `ingest` and the MCP `purix_ingest`, pass added files to it (read: `lifecycle.ts` line 1217, `server.ts` line 1707). No test covers it (I searched `modify.test.ts` and `ingest.test.ts`). Consequence: every ingested diff that adds a file fails at the last step, after the sandbox verification has already been paid for.
2. **Added files lose their final newline.** 60 of 64 added files taken from real commits came out one newline short (measured, E2). Consequence: once finding 1 is fixed, every new file would show a diff on its last line.
3. **Ingest applies a diff only at its stated line numbers.** On 1,018 real modified files, ingest reproduced the real commit byte for byte in 1,016 cases. When I shifted the line numbers by 1, 3 or 10, ingest accepted none of them, while `git apply` accepted all 1,018 and produced the correct file (measured, E2). Consequence: a diff from an agent that has edited the file since the diff was made is refused; Aider's own write-up (vendor-run) says model-made diffs frequently fail to apply cleanly, and it drops line numbers for that reason.
4. **The anchor cascade is safe.** In 1,157 anchor trials on real files with six kinds of mechanical damage, no edit landed at the wrong place (measured, E3). The independent paper below reports the same result for any policy that refuses ambiguous matches. Two gaps: a truncated anchor replaces only its prefix and leaves the tail, and an extra blank line inside the anchor is never rescued (108 of 108 not found).
5. **The two AST transforms check names, not behaviour.** Measured on hand-built cases (E4, 10 cases, not a rate): `change_control_flow` parallelised `db.begin()` and `db.query()` into one `Promise.all`; it dropped type annotations; `add_error_handling` wrapped a payment call followed by an email in a three-attempt retry; it moved a `"use server"` directive into the retry block; on a CRLF file it wrote mixed line endings; and it printed `return [a, b];}` on one line. Every output passed `tsc --strict`, so the compile step cannot catch any of these.
6. **A crash between two file writes leaves the project half changed, and recovery gives up.** I killed the process after the first of two writes: `a.ts` held the new content, `b.ts` the old (measured, E5). `purix reconcile` then refused, saying "something else touched these files". The journal row holds both snapshots, so a deterministic roll-back or roll-forward was possible.
7. **Nothing checks that a file is unchanged between verification and write.** The writer reads the "old" content again at write time and overwrites it. A human edit saved in that window is replaced (measured, E5). A drift check exists before verification (`state/drift.ts` line 33, found by grep; I did not read the whole file or the resolver's order of calls); I did not find a second check at write time.
8. **Cost is not here.** Anchor matching stays under 5 ms even at 200,000 lines; the ts-morph transform takes 0.13 s at 1,000 lines and 3.8 s at 50,000 (measured, E6, one machine). The cost of a change is the whole-component verification in document 02, not these mechanics. One exception: the "anchor not found" explanation takes 2.8 s on a 200,000-line file.

9. **`config_value` can edit the wrong text without any error.** Five cases through the real compiler (E7): with `retry1: 1` and old value `1`, it changed the key to `retry2` and left the value; with a comment `# port: 80 is default` above `port: 90`, it edited the comment and reported success. It correctly refused the same key in two sections and a value on the next line. Unlike the anchor cascade, this edit kind can land in the wrong place.

**What is already good and should not be touched.** The "unique or refuse" rule in every matcher. The function-form replacement that stops `$&` in new text being interpreted. The test-file lock on repair edits (`compile.ts`, `blockTestFileEdits`). The size limits on `modify_code`. The path guard on diff headers. Deletions in diffs are refused with a clear message (`lifecycle.ts` line 1003). Backup before write, and the rollback that reports its own failure (`modify.ts`).

## 1. How I worked, and what I could not check

**Read in the code (full):** `entrypoints/modify.ts`, `entrypoints/ingest.ts`, `manifest/commit_and_cascade.ts`, `verify/compile.ts`, `verify/anchor_match.ts`, `verify/ast_transforms.ts`, `verify/modify_code.ts`, `platform/atomic_write.ts`. **Read in part:** `manifest/store.ts` (the pending-operation functions and snapshot reader, lines 40 to 125 and 505 to 600), `state/reconcile.ts` (lines 20 to 47 and 150 to 194), `cli/.../lifecycle.ts` (lines 995 to 1030, 1080 to 1095, 1195 to 1235).

**Run:** E1 to E7 on the real code with `tsx`. Raw output: `e1_result.txt`, `e2_result_*.json`, `e3_result.json`, `e4_result.json`, `e5_result.txt`, `e6_result.jsonl`, `e7_result.json`, each next to its script.

**Sources and read depth.** Althoubi, "Look Before You Leap", arXiv 2609.11957 (**full**, single-author preprint, Oklahoma State, Python files, synthetic perturbations). Aider, "Unified diffs make GPT-4 Turbo 3X less lazy" (**excerpt**, vendor-run, 89 tasks). Glukhov and others (JetBrains Research), Diff-XYZ, arXiv 2510.12487 (**abstract and excerpt**). Git manual, `git-apply` (**excerpt** via a man-page mirror). Recast README (**excerpt**). OpenAI Codex `apply_patch` tool instructions (**excerpt**, from the Rust crate documentation that embeds them). Amazon Builders' Library, "Timeouts, retries and backoff with jitter" and "Making retries safe with idempotent APIs" (**excerpt**). Linux kernel ext4 documentation on `auto_da_alloc` (**excerpt**, reached through a Kafka issue and mailing-list copies, not from kernel.org itself). One practitioner blog on AST edit formats (secondary, used only as a pointer).

**Not done or not verified.**
- Task 9 (other languages): not researched. I read only that the AST transforms accept TypeScript and JavaScript extensions and that `indentMatters` lists Python, YAML and Makefiles.
- Windows: not run. CRLF handling, rename retries and `writeFile` behaviour were tested only on Linux.
- Formatter integration: there is none in the code (grep found `prettier`, `biome`, `dprint` only in the tool catalog). I read no primary source on range formatting, so concept 5.2 is level D.
- Whether any caller sits between verification and write that re-checks the files: I grepped for `last_synced_hash` and did not read the resolver.
- `state/idempotency.ts` exists and I did not read it; it may bear on repeat application.
- E2 used 450 commits from three public repositories (express, click, execa), each with 8 or fewer files per commit, so very large commits are not represented. Renames were excluded (`--no-renames`); I did not run a diff with a rename through ingest. From reading the code a rename section would be rejected, since `relPath` is the new path and is not on disk. That is an inference.
- E3 damage was applied by my script, not collected from real model errors; the frequency of each kind in practice is unknown. The anchors were windows of real files; real model anchors are chosen differently.
- E4 is 10 hand-built cases. It shows the hazards exist; it gives no rate. I did not harvest real functions from repositories as the protocol planned.
- My Prettier-cleanliness check in E4 was invalid (my declaration lines are not Prettier-formatted), so I report no formatting-conformance number.
- E5 killed one process on one filesystem. I did not run crash tests on a plain `writeFile` of a large file, so partial-file states (truncated mid-file) are expected from the code, not measured.
- E6 ran once per size set with 3 to 7 repetitions on a 1-CPU machine; the real-file part of the script failed on a wrong path and was not rerun.
- No claims register file was produced as `docs/claims.json`; the claims are listed in section 5 and in the protocol.

## 2. What the domain is, today, in one paragraph

A change arrives as edits from the classifier (five kinds: prompt text, config value, tool binding, error handling, control flow, plus `modify_code`, which reuses three of them with size limits) or as a unified diff from another agent. For edits, `compilePatch` applies them in order to in-memory copies of the component's files, refusing any path outside the manifest. Text kinds are string matches that must hit exactly once; the prompt-text kind goes through a four-stage cascade. The two AST kinds use ts-morph on top-level functions of TypeScript or JavaScript files. For diffs, `ingestDiff` parses the diff by hand and applies each hunk at its stated line. Both routes then verify in a sandbox, pass the gates, and call `commitVersionedChange`: write a journal row, back up each file, write each file with a plain write, update the manifest with a version check, roll the files back on conflict, record the change in the audit chain. After a crash, `reconcile` compares the disk with the journal's before and after snapshots.

## 3. The tasks and their concepts

### Task 1. Apply text edits at the right place

**Question kind:** A, D. **Quality bar:** a text edit lands exactly where the author meant or is refused with a message that lets the author retry; it never lands somewhere else (silent misapplication rate zero), and it never leaves part of the old text behind. **Large-repo bar:** the same, on files of 50,000 lines and repositories with many near-duplicate blocks.

#### 1.1 Anchor matching for prompt-text edits

**Today.** `matchAnchor` tries exact, then line-ending-insensitive, then trailing-space-insensitive, then indentation-insensitive (off for `.py`, `.yaml`, `.mk`, Makefile). Each stage must match once; two or more hits is a refusal that names the lines; zero moves to the next stage; nothing found returns the nearest region (`anchor_match.ts`, read in full).

**What it should do.** Content-anchored matching that refuses when unsure. The independent preprint measured 640 edits over 224 Python files under reindentation, trailing whitespace, line shifts and others: exact and whitespace-normalised search/replace never misapplied silently (0.000), and the one policy that did (fuzzy matching) reached 0.023 on single edits and 0.393 on multi-hunk edits. Its guard requires a minimum anchor size of 2 and refuses ambiguity. OpenAI's Codex `apply_patch` and Aider both avoid line numbers for the same reason.

**Cost and scale.** Time: exact match is a substring search, 4.6 ms at 200,000 lines (measured). The "not found" nearest-region search is 2.8 s at 200,000 lines, 0.63 s at 50,000, 0.1 s at 10,000 (measured; it grows about linearly with file length times anchor length). Memory: the line-ending stage builds two arrays the size of the file (read). Disk and network: none. Tokens: a refusal costs a model round, so the real cost of a refusal is tokens and time of one more call. Complications: none new. Marked: time measured, memory read.

**Options**

| Option | Evidence | Weakness |
|---|---|---|
| A. Today's cascade, unique-or-refuse | E3: 0 wrong-site in 1,157 trials; preprint: exact and whitespace-normalised never silent | Substring match: a truncated anchor replaces only a prefix (145 of 145 `drop_last_char` trials applied and left the tail); blank-line insertion not rescued; single-line anchors are ambiguous in 14 of 56 clean trials (25%) |
| B. A plus a minimum anchor size, and a "partial line" flag when the match starts or ends mid-line | Preprint's guard uses a minimum of 2 | Rejects legitimate one-token edits unless the flag is a warning, not a block |
| C. Fuzzy match above a similarity floor with a margin over the runner-up | Preprint: aggressive fuzzy 0.023 silent on single edits, 0.393 on multi-hunk; the guarded version 0.0001 but applicability fell from 0.98 to 0.51 | Costs a similarity scan; only safe with the margin rule |
| D. Whole-file rewrite by the model | The practitioner blog (secondary) measured it as the most applicable format on its tasks | Tokens grow with file size; lazy omissions ("keep the rest") corrupt code (Aider, vendor-run) |
| E. Line-number edits | None worth using | 99.1% silent corruption after a one-line shift (preprint) |

**Combination.** A is enough for safety. The gaps are about wasted rounds and leftover tails, so add B's warning flag only.

**Best way.** Keep A. Add a result field `partialLine: true` when an exact-stage match does not start and end on line boundaries, and show it in the verification summary so a leftover tail is visible. Do not add fuzzy matching. **Evidence level B** (own measurement plus an independent preprint). One tail case is not shown to be harmful in practice: whether the verifier catches it is not measured.

**Verdict:** one concept is enough (A), with a small addition.

**How we would know.** Replay E3 with real model anchors from the eval pack; report wrong-site rate (must stay 0), rescue rate per stage, and how often `partialLine` fires.

#### 1.2 Config-value and tool-binding edits

**Today.** `applyConfigValueEdit` finds lines that contain the key as a substring, then the lines that also contain the old value; it refuses on zero or several; it replaces the first occurrence of the old value within the line. `applyToolBindingEdit` replaces the only occurrence of the old tool string anywhere in the file (`compile.ts`, read).

**What it should do.** Edit a value in a structured file by path, not by text. For JSON, YAML and TOML that means a parser that keeps comments and order; I did not read a source on this.

**Measured (E7, five hand-built cases, not a rate).** Wrong text edited with success reported: the old value occurs inside the key (`retry1: 1` became `retry2: 1`), and the only line holding the old value is a comment that mentions the key. Handled correctly: a key `port` next to `report_dir` (the value filter picked the right line); the same key in two sections (refused as ambiguous); a value on the next line (refused). The cause is in `applyConfigValueEdit`: the key match is `line.includes(key)`, the value match is `line.includes(old_value)`, and the replacement hits the first occurrence of the old value in the whole line, key and comments included.

**Cost and scale.** Linear in file size; no measurement needed.

**Options**

| Option | Evidence | Weakness |
|---|---|---|
| A. Today: substring key and value on one line | E7: refuses ambiguity and next-line values | Silent wrong edit when the value sits inside the key or only a comment matches (E7); multi-line values are refused |
| B. Format-aware editors per file type (JSON, YAML, TOML) preserving comments | Not researched | One tool per format; large work; YAML round-trip is known to be hard (not verified here) |
| C. Treat config edits as text anchors with line context | Falls under 1.1; its cascade was 0 wrong-site in E3 | Needs the model to supply context |
| D. A plus line-level fixes: skip comment lines (`#`, `//`), match the key as a whole token at the start of the trimmed line, replace the old value only after the first `:` or `=` | Directly removes both E7 failures | Heuristic per format; a key that is not at line start (inline JSON) needs its own rule |

**Best way.** D now, because the two failures are silent and the fixes are a few lines; format-aware editors (B) later. **Evidence level B** for the failure (measured, reproducible), D for the fix (not yet shown on real config files). The experiment is E3's method on `package.json`, `tsconfig.json`, `.yml` and `.toml` files from the three repositories, with the same zero-wrong-site pass rule. **Verdict:** one concept is enough (D) once that experiment passes.

### Task 2. Apply structural transforms without changing meaning

**Question kind:** A, D. **Quality bar:** the output differs from the input only inside the target function; its meaning is unchanged except for the one intended change; it keeps the file's line endings, indentation and directives; a second application is refused or does nothing. **Large-repo bar:** the same on functions in files of 50,000 lines.

#### 2.1 `add_error_handling` (retry wrapper)

**Today.** Wraps the entire body of one top-level async function in a loop of 1 to 10 attempts (`ast_transforms.ts`, `applyErrorHandlingTransform`). It refuses empty bodies, an existing top-level `try`, and its own marker.

**What it should do.** Retry only operations that are safe to repeat. Amazon's engineering guidance says a call with side effects is not safe to retry unless it is idempotent (Builders' Library, excerpt).

**Measured (E4).** On `pay(c) { const r = await charge(c); await email(r); return r; }` the transform applied and the result compiled under `tsc --strict`. If `email` throws, `charge` runs again. On a function whose first statement is `"use server"`, the directive ended up inside the `try` block, where it no longer works as a directive. On a CRLF file the output had 4 CRLF and 13 bare LF line endings. A second application was refused in every case (idempotence holds). Class methods and object methods are refused with an honest message.

**Cost and scale.** Parse time 0.13 s at 1,000 lines, 0.7 s at 10,000, 3.8 s at 50,000 (measured; five or three repetitions; one CPU). A file of 200,000 lines was not parsed (skipped by my script). Memory not measured.

**Options**

| Option | Evidence | Weakness |
|---|---|---|
| A. Today: wrap the whole body | Measured in E4: applied, compiles, idempotent | Retries every side effect; moves directives; mixes line endings; unformatted output |
| B. Require an explicit "safe to repeat" assertion in the edit, recorded in the audit chain; otherwise refuse | Amazon guidance (idempotency is a property of the call, not knowable from syntax) | The assertion comes from the model or the human, so it is a claim, not a proof |
| C. Wrap only a named call, not the body | Narrower blast radius | Needs the call named in the edit; more edit-schema work |
| D. Use a retry helper from the project (not generated inline) | Avoids generated code | Project-specific; may not exist |
| E. Remove the transform | The retry is a quality feature, not a safety feature | Loses a working feature some users want |

**Best way.** B now: add `safe_to_repeat` as a required field of the `error_handling` edit; keep the directive prologue (leading string statements) outside the loop; copy the file's line ending and indentation into the generated text. **Evidence level C** (documented guidance plus my hazard cases, no measured effect on outcomes). Not yet shown to improve results; the experiment is a hazard corpus of 30 or more real async functions with their tests, run before and after.

**Verdict:** the bar costs too much to prove from syntax, so the task changes: **narrow the claim** (the transform now says what it assumes).

#### 2.2 `change_control_flow` (parallelise awaits)

**Today.** Merges adjacent `const x = await f()` statements into one `Promise.all`. Its guard refuses when one initializer mentions another selected variable (`ast_transforms.ts`, read). Type annotations on the declarations are not read, so they disappear.

**Measured (E4).** `const a = await db.begin(); const b = await db.query(...)` was merged. The two calls share a receiver and the first changes what the second sees, but no identifier from the first appears in the second, so the guard passed. `const a: number | undefined = await f()` became `const [a, b] = ...` with no annotation. The output had `return [a, b];}`, the closing brace glued to the last statement. All outputs passed `tsc --strict`.

**Options**

| Option | Evidence | Weakness |
|---|---|---|
| A. Today | Measured: applies the hazards | Misses side-effect order; drops annotations; formatting defect |
| B. A plus: refuse when two initializers share a root receiver or reference any identifier assigned or called earlier in the span; keep annotations by emitting a typed tuple; fix the brace and newline | Reasoning from the cases; no source | Still not a proof; shared state through globals or closures is invisible |
| C. Require an explicit "independent" assertion, as in 2.1 | Same as 2.1 | A claim, not a proof |
| D. Remove the transform | It is a speed change, not a safety feature | Loses the feature |

**Best way.** B plus C: refuse on shared receiver, require the assertion, keep annotations, repair the output shape. **Evidence level D** (my reasoning on ten cases). Not yet shown to improve results; the experiment is the same hazard corpus, with tests run before and after. If real functions in the corpus mostly trip the receiver rule, choose D (remove). **Verdict:** narrow the claim; consider removal after the experiment.

#### 2.3 Where the AST transforms stop

**Today.** TypeScript and JavaScript extensions only, top-level functions and const-assigned arrows only (`ast_transforms.ts`, read; E4 confirms class and object methods refuse). Everything else is text anchors.

**Best way.** Do nothing now. A transform for Python, Java, C# or Go needs a parser per language and belongs to the language-provider domain. **Evidence level:** none gathered. **Verdict:** open; belongs to the language-support domain.

### Task 3. Apply an external diff

**Question kind:** A, D. **Quality bar:** a diff that `git apply` accepts on the same base gives the same bytes; a diff with shifted line numbers is applied only when its context identifies one place; an ambiguous or stale diff is refused with the reason; added files, empty files and a missing final newline come out exactly as in the commit. **Large-repo bar:** the same, with diffs touching dozens of files.

#### 3.1 Hunk application

**Today.** `parseUnifiedDiff` and `applyHunks` in `ingest.ts` (read in full). Each hunk is applied at its stated old-line number; every context and removed line must match exactly at that position; anything else is a refusal. No offset search, no line-ending handling beyond what `split("\n")` keeps.

**Measured (E2).** 450 commits, 1,018 modified files: ingest output equal to the real file in 1,016; in the other two only the final newline differed (cause not examined; probably the `\ No newline` marker, which the parser ignores: an inference). With line numbers shifted by 1, 3 and 10: ingest accepted 0 of 1,018 at each shift; `git apply` accepted 1,018 of 1,018 at each and every result equalled the real file. Deleted files: ingest accepts 10 of 10 (the CLI then refuses them).

**What it should do.** The research says content context is the safe anchor. The independent preprint measured GNU patch at fuzz 0 and fuzz 2 on 640 edits: never silent in the stress set, applying 0.375 to 0.536 of perturbed diffs; one silent case in 8,320 trials came from nonzero fuzz. Aider and Codex `apply_patch` drop line numbers. `git apply` is documented to fail the whole patch and touch nothing when a hunk does not apply.

**Cost and scale.** Linear in diff size and file size. A search for the old-side block at other offsets is linear in file length per hunk (expected; not measured). Complications: none.

**Options**

| Option | Evidence | Weakness |
|---|---|---|
| A. Today: exact line number | E2: 1,016 of 1,018 correct; 0 accepted when shifted | Refuses every stale or model-numbered diff; costs a retry |
| B. A plus an offset search: if the old-side block does not match at the stated line, look for exactly one other place where the whole block matches, otherwise refuse | `patch` and `git apply` do this; preprint: GNU patch fuzz 0 never silent | Needs code and tests; context must be the full block (no fuzz) |
| C. Delegate to `git apply` in a staging copy, read the resulting files | E2: reproduced the real commit on 1,018 of 1,018; documented all-or-nothing | Needs the git binary on the machine; behaviour on CRLF and on files with unusual attributes (`.gitattributes` filters) not tested |
| D. Context-anchored custom format (Codex `apply_patch` style) | Models are trained on it by OpenAI | A second format to parse; only useful where Purix, not an external agent, writes the diff |
| E. Fuzzy context | Preprint: unsafe on multi-hunk | Silent misapplication |

**Best way.** C for the main path, with B as the fallback when git is missing. Reason: C reproduced real commits exactly in this run, handles added, empty and renamed files, modes and the no-newline marker without our code, and is all-or-nothing. Keep today's path-guard and the line-by-line context check as a second check on the result. **Evidence level B** (own measurement on three repositories plus documentation). Not shown on CRLF repositories or on repositories with attribute filters; the experiment is E2 on a CRLF repository and a Git LFS repository.

**Verdict:** a combination reaches the bar (C with B as fallback).

#### 3.2 Added, empty, renamed and deleted files

**Today.** Added files: parsed, content built from `+` lines joined with a newline, so the last newline is dropped (E2: 60 of 64). An added empty file has no hunks and no `---` line, so ingest says "no recognizable unified-diff file section" (1 of 64 in click). Renames: expected to be rejected (read, not run). Deleted files: parsed and accepted by `ingestDiff`, refused by both callers.

**Cost and scale.** None.

**Best way.** If 3.1 picks `git apply`, all four come with it. Otherwise: keep the final newline unless the diff has the no-newline marker; accept empty-file sections; map renames to a delete plus an add. **Evidence level B** for the newline finding (measured), D for the rest. **Verdict:** a combination, folded into 3.1.

### Task 4. Scope of a change

**Question kind:** A. **Quality bar:** an edit can touch only files the component owns; one change has a size limit a reviewer can read; a change that spans several components is explicit. **Large-repo bar:** the same, plus a way to land a cross-component change.

**Today.** `compilePatch` refuses any path not in the component's file list (`compile.ts`). `modify_code` allows at most `MODIFY_CODE_MAX_EDITS` edits and `MODIFY_CODE_MAX_LINES` lines each (`modify_code.ts`; the numbers are in `llm/prompts/edit_kinds.js`, which I did not read). Ingested diffs that modify a file not tracked by the component are refused. There is no edit kind for renaming or moving across files, and no way for one change to cover two components (read: `lifecycle.ts` line 1011 to 1017).

**Options**

| Option | Evidence | Weakness |
|---|---|---|
| A. Today: one component per change | Read; simple to audit | A rename across components is impossible; a large company's common refactor does not fit |
| B. Multi-component change as one journal entry with one verification | Not researched | Contract changes cascade (document 02 task 2.5); larger blast radius |
| C. Split a cross-component change into ordered single-component changes, each verified | Fits the current model | Intermediate states must compile; not measured |

**Best way.** C for now, and say so in the product: a cross-component refactor is a sequence. **Evidence level D.** **Verdict:** narrow the claim. I did not research how mature refactoring tools (OpenRewrite, jscodeshift) scope a change; that is a gap.

### Task 5. Formatting and normalisation

**Question kind:** A, D. **Quality bar:** a change shows only the lines the author meant (no whitespace noise, no mixed line endings, no reflowed neighbours). **Large-repo bar:** the same on a repository with a mandated formatter, where a stray change fails the company's own CI.

#### 5.1 Output shape of the generated code

**Today.** There is no formatter step (grep). The AST transforms insert text built from template strings with `\n` and fixed two-space indentation (`ast_transforms.ts`).

**Measured (E4).** CRLF file: mixed endings. Retry wrapper: the wrapped body keeps its original indentation inside deeper nesting, and a blank line appears after `try {`. Control flow: closing brace on the same line as the last statement.

**What it should do.** Format-preserving rewriting: Recast's README says it reprints only the parts of the tree that were modified and falls back to a generic printer for nodes it cannot reprint from the original source. ts-morph is a different tool and I did not read its docs.

**Options**

| Option | Evidence | Weakness |
|---|---|---|
| A. Today | Measured defects | Noise, mixed endings |
| B. Detect the file's end-of-line and indent unit; generate text with them; re-indent the moved body | Reasoning; same technique the anchor matcher already uses (`dominantEol`) | Handles the known defects only |
| C. Run the project's own formatter on the changed range | Common practice; not researched in a primary source here | Needs the project's formatter config; range support varies by tool; adds time |
| D. Run the formatter on the whole file | Simple | Rewrites unrelated lines at scale; diff noise in review |
| E. Recast-style printer | Recast README | Another dependency; JavaScript and TypeScript only |

**Best way.** B now, because the defects are in our own templates. C later as an option of the language provider. Do not choose D. **Evidence level D** for B (my reasoning, backed by the measured defects) and no evidence for C. Not yet shown to improve results; the experiment is E4 on a Prettier-formatted corpus counting changed lines outside the target function.

**Verdict:** a combination (B, later C).

#### 5.2 Normalisation of text-anchor replacements

**Today.** Replacement text is converted to the file's dominant line ending in stages 2 to 4; in the indent stage it is re-indented by the difference (`anchor_match.ts`). In the exact stage the replacement is inserted as written.

**Best way.** Keep. A mixed-ending file is treated as its majority style (read). **Evidence level C**, tested in E3 only for presence of the marker at the right line, not for exact bytes. Gap listed in section 5.

### Task 6. Repeat application and replay

**Question kind:** A, D. **Quality bar:** applying the same change twice either does nothing or is refused; replay from the library gives the same bytes. **Large-repo bar:** the same.

**Today.** Both AST transforms refused a second application in all eight cases that applied in E4 (measured). For text anchors a second application succeeds whenever the new text still contains the old text: replaying `x = 1` to `x = 1; y = 2` gave `let x = 1; y = 2; y = 2;` (measured, E7). The journal's `after_snapshot` makes replay deterministic.

**Best way.** Keep. Add a check in `commitVersionedChange`: if the final contents equal the current contents, report "no change" and do not bump the version. I did not check whether the callers already do. **Evidence level B** for the double application (measured, one case), D for the fix. **Verdict:** one concept is enough, with an unverified gap in the callers.

### Task 7. Land the change on disk

**Question kind:** A, B. **Quality bar:** after a crash at any point, the project holds either the old or the new contents of every file, and recovery restores consistency without a human; a file changed by a person after the change was based on it is never overwritten silently. **Large-repo bar:** the same, with hundreds of files in one change and the working tree open in editors.

#### 7.1 Writing source files

**Today.** `applyModificationFiles` backs up each file in memory (a fresh read), then writes each with `fs.writeFile` and rolls back on failure, reporting a failed rollback (`modify.ts`). State files use the atomic writer (`atomic_write.ts`: temp file in the same directory, `fsync`, rename, directory `fsync`, retries on Windows). The source files do not.

**Measured (E5).** A kill after the first of two writes left `a.ts` new and `b.ts` old. A plain `writeFile` truncates and then writes, so a crash inside a large write can leave a partial file; I did not test that, it is read from how `writeFile` works.

**What it should do.** Replace each file by writing a temp file, syncing it, and renaming it over the target. The ext4 documentation says its replace-via-rename heuristic exists for applications that skip `fsync`, and a kernel bug thread and an engineering issue (Kafka) show zero-length files after crashes without it; durable replacement needs `fsync` before the rename (excerpts, secondary). The repository's own writer already does this and records the Windows limit in its header comment.

**Cost and scale.** One extra temp file per changed file and one `fsync` each; time per file is a disk sync (milliseconds on SSD, not measured). Disk: the size of the changed files twice, briefly. For hundreds of files in one change the syncs add up (expected, not measured).

**Options**

| Option | Evidence | Weakness |
|---|---|---|
| A. Today: plain `writeFile`, in-memory backup | Read; unit-tested rollback | Crash leaves mixed or partial files (E5) |
| B. `writeFileAtomic` per file, plus journal-driven recovery | The code and the ext4/Kafka evidence | Still not atomic across files (POSIX has no multi-file atomic rename); needs 7.3 |
| C. Stage the whole change in a temp tree and swap directories | Atomic per tree | Does not fit a working tree with editors open, `.git`, and untracked files; copy cost grows with the repository |
| D. Apply through `git apply`, which is all-or-nothing | Documented | Atomic for the apply only; a crash during its write phase is not covered by that documentation (not verified) |

**Best way.** B plus 7.2 and 7.3. **Evidence level B** for the need (measured crash state plus documentation), C for the claim that B closes it (the combination is not tested). The experiment is E5 repeated with a kill at every write boundary and with a large file, checking that `reconcile` restores a consistent state each time.

**Verdict:** a combination reaches the bar (B, 7.2, 7.3).

#### 7.2 Detect a change made by someone else

**Today.** The journal row is created from the snapshot the change was based on. `applyModificationFiles` then re-reads each file and treats that as the backup; it never compares it with the snapshot. A drift check exists before verification (`state/drift.ts`).

**Measured (E5b).** Disk held "A1 plus a human edit"; the change, based on "A1", was written; the human edit was gone from the file (the backup held it, in memory only).

**Options**

| Option | Evidence | Weakness |
|---|---|---|
| A. Today | Measured | Silent overwrite |
| B. Compare each file's current content with the snapshot hash immediately before its write; refuse the whole change on a mismatch | Same idea as the manifest's own version check; `git apply` fails when context does not match | Adds one read and hash per file; refuses a change when an editor autosaves a trailing newline |
| C. Lock the files against editors | Not portable | Intrusive |

**Best way.** B, and treat a mismatch as its own result ("files changed since the change was prepared"), not a code failure, so it never enters the repair loop. **Evidence level B** (measured hazard; fix is the same pattern as the repo's manifest check). Cost: a hash of each changed file, linear in size, small next to verification (expected).

**Verdict:** one concept is enough.

#### 7.3 Journal and recovery after a crash

**Today.** `reconcile` marks an operation landed if all files equal the after snapshot, "still before" if all equal the before snapshot, and otherwise prints that something else touched the files and stops (`reconcile.ts`, read at the two branches). When the files do match the after snapshot but the interrupted write then fails verification, it rolls back to the before snapshot (lines 173 to 185).

**Measured (E5a).** The mixed state after the kill fell into the last branch, with a message that blames another process. The journal row had both snapshots.

**Options**

| Option | Evidence | Weakness |
|---|---|---|
| A. Today | Measured | Needs a human for the most likely crash state |
| B. Per-file classification: each file equals before or after; if every file is one or the other, roll forward or back deterministically; only a file equal to neither goes to a human | Follows from the journal content | Must choose forward or back; roll back is safer (the change was not yet verified as landed) |
| C. Add a state column to the journal (`writing`, `written`, `committed`) | Standard write-ahead journalling | Schema change and migration |

**Best way.** B, rolling back when the manifest version has not moved, and say what was done. **Evidence level C** (design reasoning from the journal; not tested). The experiment is E5a at every write boundary. Also delete the journal row on the failed-write branch of `commitVersionedChange` (E1 left one behind; the next `reconcile` clears it as "no write had landed", read, not run).

**Verdict:** one concept is enough.

#### 7.4 Create and delete files

**Today.** Writer cannot create (finding 1). Deletion is refused by both callers. Neither creates parent directories (`modify.ts`).

**Best way.** In `applyModificationFiles`, treat a missing file as `before = null` and create it, with its directories, through the atomic writer; add deletion with `before` kept in the journal. **Evidence level B** for the failure (E1), D for the fix. **Verdict:** one concept is enough, and it must come first because finding 1 blocks `ingest`.

### Task 8. Language coverage

**Question kind:** B. Not researched. Read only: AST transforms are TypeScript and JavaScript; `indentMatters` protects Python, YAML and Makefiles; everything else is text anchors. The document that covers language support must answer whether Java, C# and Go need their own transforms and their own formatters. **Status: open.**

### Task 9. Cost and scale of the mechanics

**Question kind:** C. **Quality bar:** mechanics cost under 5% of the time of verification, at every file size seen in practice. **Large-repo bar:** the same at 50,000-line files.

**Measured (E6, one machine, 1 CPU).** Anchor exact match: 0 ms at 1,000 lines, 4.6 ms at 200,000. ts-morph transform: 0.13 s, 0.7 s, 3.8 s at 1,000, 10,000, 50,000 lines. "Not found" diagnostic: 7 ms, 0.1 s, 0.63 s, 2.8 s at 1,000, 10,000, 50,000, 200,000. All are small beside the whole-component verification (document 02: 21.6 s for 10 files).

**Options and best way.** No option needed except the diagnostic: cap the nearest-region search to the first 20,000 lines or a time budget, and say so in the message. **Evidence level B** (measured, one machine). **Verdict:** one concept is enough (no change except the cap). Differences between a company and one developer: none; no configuration profile is needed.

## 4. How the picks fit together

Order dependencies between the picks: 7.4 has to exist first; 1.2's two-line fix has no dependency and can go any time (a new file can be written), then 3.1 and 3.2 (diffs apply with their final newline), then 7.2 and 7.1 and 7.3 together (they share the writer), then 2.1 and 2.2 (the assertions and the output shape), then 1.1's flag. The first two items remove failures that cost a full verification each. The tiers of document 02 are unaffected: every mechanic here runs inside T1 (under 2 s), except the AST transform on files above about 20,000 lines, which moves to T2.

## 5. What this document did not settle

- Claims register (statement, status, evidence, snapshot): C1 holds (measured); C2 holds with a note (the row is cleared by the next reconcile; read, not run); C3 holds (measured); C4 holds in part (a drift check exists earlier; no re-check at write found); C5 holds (measured); C6 holds (measured, E7); C7 holds (measured on one case); C8 holds (measured on one case); C9 holds (grep); C10 holds (read).
- The effect of each proposed fix on outcomes. All are level B, C or D; none is shown to improve results end to end.
- Real model errors: E3 damage is mine. The frequency of each kind in real traces needs the eval pack.
- Python, Java, C#, Go mechanics; Windows behaviour; CRLF and attribute-filtered repositories for `git apply`.
- Config-value edits on real config files: the failures are measured on five hand-built cases; the fix is untested (1.2).
- How OpenRewrite, jscodeshift and Comby scope and verify a change.
- Whether `state/idempotency.ts` already covers repeat application.
- A Windows run of E5 (rename retries, `writeFile` on a locked file).
- Decisions to ratify: none of these findings contradicts an ADR I read; I did not search the vault for ADRs about the writer, so none is named.

## 6. Sources

**Primary**
- Althoubi, A., "Look Before You Leap: Pre-Action Verification for LLM Agents", arXiv 2609.11957, August 2026. Read in full. Single-author preprint; synthetic perturbations; Python files; GNU patch used as the diff engine.
- Glukhov, Conti, Bogomolov, Golubev, Bezzubov (JetBrains Research), "Diff-XYZ: A Benchmark for Evaluating Diff Understanding", arXiv 2510.12487. Abstract and excerpt.
- Git manual, `git-apply(1)`. Excerpt, through a man-page mirror.
- Recast README (benjamn/recast and forks). Excerpt.
- OpenAI Codex `apply_patch` tool instructions, as embedded in the crate documentation at docs.rs. Excerpt.
- Amazon Builders' Library: "Timeouts, retries, and backoff with jitter" (M. Brooker) and "Making retries safe with idempotent APIs". Excerpt.
- Linux kernel documentation, ext4 `auto_da_alloc`. Excerpt via copies in a Kafka issue and mailing-list posts, not retrieved from kernel.org.
- Purix source and `research-04-experiments/` scripts and output.

**Vendor-run or secondary (used with labels)**
- Aider, "Unified diffs make GPT-4 Turbo 3X less lazy" (vendor-run, 89 tasks; excerpt).
- A practitioner blog comparing seven edit formats including AST edits (secondary; used only to point at AST edits as an option, none of its numbers used).
- Kafka issue KAFKA-15312 and a Linux kernel bugzilla thread on zero-length files after crashes (secondary).

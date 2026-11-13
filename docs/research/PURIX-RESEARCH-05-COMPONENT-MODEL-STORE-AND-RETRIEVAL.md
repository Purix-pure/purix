# Domain research 05: Component model, store and retrieval

## Verification update, 2026-10-31 (method v2)

**Status under method v2: Settled with gaps.** Pins: code `packages__2_.zip` d873c00c78b6822c; vault `purix-knowledge-working-2026-10-04.zip` 483002fb893b0085 (declared current by the owner on 2026-10-31, refresh after domain 16); Linux, Node 22.22.2; one run each. Full detail: `PURIX-RESEARCH-VERIFICATION-04-07-2026-10-31.md`. Probes: `research-verify-experiments/`. No finding below was deleted.

**Re-run results.** Finding 1: partly confirmed by reading. `linkComponents` callers are `mcp-server/src/server.ts`, `cli/.../lifecycle.ts` and `core/manifest/store.ts`; the scaffold path setting `depends_on: plan.depends_on` was not traced; the "0 of 3 edges" run was not repeated. Findings 2 to 12 not re-run.

**Gaps added.** (a) Indexing cost (finding 3) has three conflicting session results; repeat three times at 10, 100 and 1,000 files on one real repository before anyone plans from it. (b) Finding 2 uses commit subjects as intents. A subject is written after the change and often names files, which flatters lexical matching and is a threat to construct validity; it should be stated as one. (c) Finding 5 measures recall against exported declarations; whether exports are the right target for retrieval is not argued. (d) The experiment folder is `exp05/` in the text and `research-05-experiments.zip` in the upload; confirm they hold the same scripts. (e) Findings 1 and 2 are the ones other documents lean on (02, 07); a different session should re-run them first (Rule B).

Prepared 2026-10-29 from the Purix code zip (`packages_2.zip`), the vault (dated 2026-10-04), documents 00 to 03 and the method document, public sources, and experiments run on Linux. The file number follows the order of completion as far as I know; the verification domain is running in another session and may have taken 04. This document covers how a component comes to exist, how it is stored, how it is found again, and how it is kept true. Status: **settled with gaps**. The measured parts (indexing cost, extraction recall, retrieval accuracy, store scale, edges, staleness, path base, library chain) are measured. The proposed replacements are mostly evidence level C or D and each names the experiment that would raise it.

**Merged version.** A second session researched the same domain independently (1 CPU, 4 GB, Node 22.22.2; zod, flask, requests, scip-typescript). I read its document and scripts and re-ran two of its experiments (symbols table, zod symbol recall); both reproduced. This version merges the two. Where a finding was reached independently it is marked "confirmed twice". Findings that only the second session produced are marked "second session" and say whether I re-ran them. Its numbers that I did not re-run (zod compiler-truth recall, `runIndex` on zod files, scip-typescript timing, one-row read at 50,000 and 250,000 symbols) are reported as its measurements. Its document left model-context retrieval (its task 7) open; this one measures intent-to-file retrieval (task 5) but does not cover how context is built for the model prompt (ADR-059), which stays open.

Snapshot: code zip sha-256 d873c00c78b6822c, private zip 8590a498880f25cc, vault 483002fb893b0085 (all match the method document). Linux, Node 22.23.4, 2 CPUs, 8 GB. Every timing is a single machine; spreads are shown. The protocol was written before searching and is in `exp05/PROTOCOL.md`.

## 0. Read this first

This domain is what the person calls Purix's real core: the model of the codebase that every change is aimed at. It has four kinds of "component" that share one word. A created component is one to three files that `create` scaffolds. An adopted component is one file plus its sibling test, registered by `adopt`. A symbol record is one entry inside the single aggregate row called `purix-codebase-index`. The index row is that aggregate itself. Much of what goes wrong comes from treating these four as one thing.

Findings that matter most:

1. **Dependency edges are empty for everything the indexer and adopt produce.** I indexed and adopted three files that import each other. The store recorded 0 of 3 true import edges. Every adopted entry has `depends_on` and `depended_on_by` empty, and `getDependents` returns nothing. Edges exist only when `create` copies the model's own declared plan (`entrypoints/scaffold.ts`, `depends_on: plan.depends_on`) or when `linkComponents` is called by hand. Consequence: the dependent cascade (document 02, task 2.5), neighbour context in repair (`recovery/escalate.ts`) and the dependents re-verify (`verify/impact.ts`) do nothing for the index and adopt route. The cost estimates in document 02 that assume a cascade apply only to created components. A crash-recovered create is also rebuilt with empty edges (`state/reconcile.ts`). Confirmed twice: the second session ran the real store, adopt and cascade functions on two files and got zero dependents; it also found the callers of `linkComponents` are the scaffold paths only (`lifecycle.ts` line 410, `server.ts` line 1081, as it reports; I did not re-check those line numbers).
2. **Retrieval from an intent finds the right file far less often than a plain lexical baseline, and names the wrong file with a single confident answer 1% to 23% of the time.** Using real commit subjects from six public repositories as intents (about 1,500 in total), the code's own route picked the correct file 2% to 12% of the time, a wrong single file 1.3% to 23.3%, and nothing 59% to 91%. BM25 over file paths and symbol names ranked the correct file first for 20% to 30% and in the top five for 46% to 61%. Consequence: exact matching is a safe fast path, not a retrieval method, and the "single match proceeds" rule needs a stricter condition.
3. **Indexing costs 2 to 6 seconds per file and the cost depends on the project, so "files squared" is neither confirmed nor refuted.** My runs on a synthetic chain of tiny files, three repetitions each: 10 files 24.5 to 27.4 s, 20 files 40.0 to 57.7 s, 40 files 84.0 to 86.5 s (2.1 to 2.7 s per file, roughly linear). The second session ran the real `runIndex` on subsets of zod, one run each: 5 files 18 s, 10 files 38.4 s, 20 files 128 s (3.6, 3.8, 6.4 s per file, clearly superlinear; every file failed verification because the subset lacks its imports, which still costs compiler time). Document 02's points (10 files 21.6 s to 80 files 390.5 s) sit between the two. The reading that fits all three: cost per file is at least 2 seconds, and it rises with how much code the whole-project copy and compile have to process. The cause is read in the code: `runIndex` calls `verifyInSandbox` once for every file. At 2 seconds a file, 1,000 files is about 35 minutes and 5,000 files about 3 hours (an extrapolation, not a measurement; the zod rate would make it worse). Replace "files squared" with "per file, at least linear, superlinear on heavier code".
4. **A parse-only index with an import graph runs in seconds on real repositories.** Warm runs: requests (37 files) 0.00 s; flask (83) 0.01 s; got (96) 0.42 s; django (3,048) 0.39 s; nest (2,193) 0.84 s; typeorm (3,621) 1.19 s; vscode (15,359) 30.5 s. First runs are slower (disk cache): nest 3.98 s, typeorm 4.95 s, vscode 53.8 s. Between 98.5% and 100% of relative imports resolved to a repository file. Consequence: the index can run at the interactive tier and be rebuilt per clone, which removes the need for a shared index service at this size.
5. **The symbol extractor misses about a quarter of TypeScript exports and falls back to whole-file records for a third or more of TypeScript files.** Recall against the TypeScript compiler on exported declarations: got 77.0%, nest 76.5%, typeorm 73.2%. It never finds `export default`, `export { x }`, `export * from`, `export enum` or `export abstract class` (0% in every repository). Python top-level `def` and `class` recall is 100% (django 9,231 of 9,232). Share of files with no symbol found, so a whole-file record: TypeScript 35% to 72% in my three repositories, Python 22% to 31%. The second session measured zod against the compiler's locally declared exports: 1,260 of 1,981 found (63.6%), and 89 of the 186 files that export something yielded none. It found one more cause I had missed: the pattern uses `\w`, which excludes `$`, so names such as `$ZodType` are never found; names exported under another name (`export { _undefined as undefined }`) are also missed. I re-ran my own comparison on zod (reference counts every export form, including re-exports): 57.3% recall, 79.5% of files with a whole-file record, `interface` 43.9% and `type` 53.8%. So TypeScript recall spans 57% to 77% across four repositories. Confirmed twice for TypeScript; Python top-level recall is 100% in both (second session: flask 556 of 556, requests 203 of 203).
6. **The ignore rules are a literal prefix match with a name list, not gitignore.** In a test tree (not a Git repository), a source folder named `build` or `dist` was skipped, a `*.generated.ts` glob in `.gitignore` was ignored (the file was indexed), and a nested `.gitignore` was ignored (the file was indexed). Git decides all three differently. A file under an excluded name is silently not governed.
7. **Paths in the index depend on where the command runs.** `file_location` is built from the working directory while `files` is built from the indexed directory. Run from the parent, the symbol record says `proj/src/a.ts` and the files list says `src/a.ts`. This is the follow-up recorded in ADR-068, confirmed by a run. Adopt's language lookup and the resolver's symbol-to-owner match both compare these two strings and break.
8. **Nothing detects a stale symbol.** After renaming a function by hand and not re-indexing, the old name still resolves to a single confident owner (score 110) and the new name resolves to nothing. `purix check` does detect file drift; the resolver does not look.
9. **The index row's own status leaks into `purix check`.** One broken, ungoverned file made `purix check` report "Check failed: 2 problem(s)" because the index row counts as a governed component whose last verification failed. `status_view.ts` in the MCP server excludes the row; `check.ts`, `evidence.ts` and the CLI status view do not.
10. **The operation library's hash chain breaks on update or eviction, and no production code ever checks it.** The chain verified after four inserts and failed ("Broken prev_hash", index 0) after re-promoting an existing entry and after evicting only the oldest row. ADR-043 specifies both the chain and a 50,000-entry least-recently-used cap. Two ADR-043 behaviours cannot both hold as built.
11. **The store reads the whole index row on every call.** With 10,000 components and a 100,000-symbol index row (about 26 MB), `listManifest` took 147 to 292 ms and `resolveTarget` 49 to 134 ms. With 50,000 components, 307 to 370 ms and 206 to 567 ms. The hook budget in document 02 is 100 ms for the whole call, so the current layout cannot meet it beyond roughly 10,000 components.
12. **The only team-shared artifact is the committed lock file.** The store sits in the git common directory (shared across worktrees, ADR-042) and is not shared across clones or developers. What one developer adopts is invisible to another until the lock is committed, and then only as a hash.

What is already good and should not be touched: the optimistic version commit (`commitManifestVersioned`), the write-ahead pending-operations journal and the integrity probe that moves a corrupt store aside (`manifest/store.ts`); verbatim filtering of model-proposed mentions (`filterVerbatimMentions`) which lets a model help find names without inventing them; the deterministic ranking with a total-order tiebreak in `resolver.ts`; "adopt on demand" (ADR-068) as the unit of consent.

## 1. How I worked, and what I could not check

**Read in the code (in full unless noted).** `manifest/indexer.ts`, `adopt.ts`, `resolver.ts`, `mentions.ts`, `change_target.ts`, `store.ts` (696 lines), `library.ts`, `commit_and_cascade.ts`, `verify/impact.ts`, `entrypoints/scaffold.ts` and `check.ts` (the parts that touch edges and status), `recovery/escalate.ts` (neighbour context), `state/reconcile.ts` (line 84 region), `state/governed_lock.ts`, `state/git_common_dir.ts`, `state/hash.ts`, `language/registry.ts`, `language/providers/typescript.ts`, `cli/.../change.ts`, `mcp-server/src/server.ts` lines about 1380 to 1440, `status_view.ts`, `evidence.ts`. Not read or only partly read: `hooks/run.ts`, `manifest/observability.ts`, `lifecycle.ts` around the delete path, and the bodies of ADR-036, 059, 067 and 069 (I did not open them in full). I name no decision from those four.

**Vault.** ADR-068, 063, 043, 039 and 042 read. The vault is dated 2026-10-04 and the code to 2026-10-13, so every "code disagrees with ADR" item below needs a check against the current vault before ratification.

**Experiments run (scripts in `exp05/`).** All on synthetic fixtures or public repositories cloned read-only and never executed: got, nest, typeorm, flask, requests, django, vscode, aider. The real `runIndex`, `resolveTarget`, `lookupAdoptable`, `extractMentions`, `writeManifest` and `listManifest` were run unchanged (TypeScript sources loaded through tsx). The extraction regex was copied unchanged with `export` added.

**Sources, with read depth.** The web fetch tool returns a summarised excerpt, so every web source below is read at excerpt depth unless stated; none was read in full. Aider's own source: excerpt, by searching `repomap.py` in the clone (commit 5dc9490, dated 2026-05-22), not a full read. Pages the fetch tool refused (arXiv abstract, aider.chat documentation, git-scm gitignore page) were not retried by another route; I used a search-returned mirror (ar5iv) for SWE-bench and the kernel.org copy of the gitignore manual instead.

**Could not check, and what it would cost to close:**

- The model-assisted tier of `purix change` (`extractMentionCandidates`). No provider key here. One afternoon with a key: rerun experiment E6 with the model tier on.
- Windows and macOS. All numbers are Linux. Path separators matter for the path-base finding. One run per platform of the five scripts.
- A design partner's repository. The six public repositories are open-source TypeScript and Python. Large-company code is probably Java, C# and Go (an assumption from document 02, not researched); extraction recall for those languages is unmeasured.
- Precision of the regex extractor (false positives, for example `export` inside comments or strings). I measured recall only.
- The proposed edge method against compiler-resolved truth. I measured how many relative imports resolve to a repository file, not whether each resolved edge is the right one. Python absolute imports and TypeScript path aliases were not resolved in my script.
- Merge behaviour of the committed lock at 100 developers (not tested; document 02 also did not test it).
- Whether `purix_find` over MCP falls back to `lookupAdoptable`. I traced the CLI route (`change.ts`) only.
- Re-index after a small change (incremental cost) for the proposed index. Not run.
- The second session's scip-typescript run, its `runIndex` runs on zod and its one-row read at 250,000 symbols were not re-run by me; its DraCo and RANGER readings were not re-read by me.
- How the model prompt's context is built from the index (ADR-059; the prompt-building code). Neither session read it. Protocol for it: tasks (selection, budget, order, caching), options (today's code, ADR-059, Aider-style repository map, graph retrieval as in DraCo and RANGER, SCIP-based retrieval), experiment (context built by each method for 100 real changes, scored by inclusion of the changed files and their dependents at a fixed token budget).
- Kythe: read the schema overview only. SCIP, Glean, stack graphs, Agentless, CodeRAG-Bench, Zoekt, Nx, Backstage were read at excerpt depth from the pages listed in section 6.
- The Cursor index and Google monorepo material were not re-read; document 02 cited the Cursor index.

**What counts as a repeated timing.** E5 and E7 have three repetitions each, with the spread printed. E6 and E2 are counts, not timings. E1, E3, E4, E8, E9 and E10 are single deterministic runs. The first repetition of a parse-only timing includes cold disk cache; I report both.

## 2. What the domain is, today, in one paragraph

`purix index` walks the directory, runs a full sandbox verification on each supported file, extracts exported names with a regular expression, and writes one aggregate manifest row (`purix-codebase-index`, status "fail" if any file failed) plus `.purix/components.json`. `purix adopt <file or symbol>` turns one indexed file into a component (status "pending", sibling test attached, no edges). `purix create` makes a new component of one to three files whose edges are whatever the model's plan said. All manifest entries are JSON blobs in one SQLite table at `<git common dir>/purix-state/manifest.db` (schema version 5). `purix change "<intent>"` extracts mentions from the intent and matches them exactly against component ids, owned file paths and indexed symbol names; a model-assisted extraction pass runs only if nothing matched. A committed lock file records a hash per governed file. A separate operation library, keyed by a hash of component, operation and normalised instruction, keeps promoted operations in a hash chain.

## 3. The tasks and their concepts

### Task 1. What a component is, and who owns what

**Quality bar.** For any file in the repository, the system can say which component owns it, or that none does, the answer is the same for every developer on the same commit, and it does not depend on the directory the command runs from. A change aimed at a file or a name reaches exactly one component or is refused.

#### 1.1 The unit of governance

**Today.** Four things carry the word component (section 0). The unit a change targets is the adopted or created component. Adopt is per file (`adopt.ts`, `buildAdoptedEntry`, `component_type` "module"). The language of an adopted file is looked up through the index records by comparing `file_location` to the file string (finding 7).

**What it should do.** Match the unit to how large systems describe ownership. Backstage's Component kind carries an owner, a lifecycle, `dependsOn` and `subcomponentOf` and is declared in a file next to the code (excerpt). CODEOWNERS maps path patterns to owners, last matching pattern wins (excerpt). Nx infers a project from `package.json` and project files and builds its graph from imports (excerpt). All three treat a package or a directory as the unit people reason about, and a file as a member of it.

**Quality bar.** Ownership is total and unique over tracked source files; the unit is something a reviewer can name in a sentence.

**Cost and scale.** The number of components a company holds is the number of adopted files in practice, because adopt is per file. The Free tier caps components at 25 (`licensing/tier.ts`, `componentLimit: 25`, read by me; the second session also read the check in `store_component_limit.test.ts`), so per-file adoption meets the cap within a few changes. At 1,000 components the store is small (E7). At 10,000 components `listManifest` costs 46 to 83 ms and the hook budget is consumed (finding 11). Measured.

**Large-repo bar.** Tens of thousands of files, 100 developers, ownership answerable in under 100 ms and the same on every clone.

| Option | Evidence | Weakness |
|---|---|---|
| Per-file adopted component (today) | Code read, E1 to E10 | Component count equals file count; no grouping a human can name; edges absent |
| Per-package or per-workspace component declared from build files | Nx and Backstage, excerpts | Needs a provider per ecosystem; the unit is coarse, so a change touches many files under one verification claim |
| Path-pattern ownership set (CODEOWNERS style) | GitHub docs, excerpt: last match wins, 3 MB file cap, no negation | Pattern files are flat; no per-component version or status |
| Declared catalog file per component (Backstage style) | Backstage descriptor format, excerpt | Someone has to write and maintain them; drifts from code |
| Keep per-file components, add a derived package label | Own reasoning (level D) | A label is not a unit of verification; it only groups |

**Combination.** No single option reaches the bar. Per-file components are the right unit of verification and consent (adopt on demand, ADR-068). They fail the "reviewer can name it" half. A derived grouping label fixes the second half without changing what is governed.

**Best way.** Keep per-file adopted components as the unit of governance and verification. Add a derived `group` label per component taken from the nearest `package.json`, `pyproject.toml` or `go.mod`/`pom.xml`/`.csproj` directory, computed at index time and not stored as a separate kind of component. Keep symbol records as a retrieval index only and stop calling them components in output. Evidence level D (own reasoning with C precedent from Nx and Backstage); not yet shown to improve results. Experiment: on the six repositories, count how many distinct groups the derived label gives and whether a reviewer can name a typical change's group; measure by hand on 30 commits.

**How we would know.** Ownership query over a tracked file returns exactly one component or "none", on every clone of the same commit; a test that runs the query from a parent directory and a subdirectory and expects the same answer.

#### 1.2 Ownership shared across developers

**Today.** The store is `<git common dir>/purix-state/manifest.db` (`state/git_common_dir.ts`, `manifest/store.ts`). Worktrees of one clone share it; separate clones do not. The committed `purix.lock.json` holds a sha-256 per governed file (`state/governed_lock.ts`) and is the only team-visible record. `isLockable` excludes the index row. I did not test two clones.

**What it should do.** A second developer who clones the repository gets the same governed set. Document 02 flagged the lock as a likely merge hotspot and did not test it. CODEOWNERS shows the precedent for a committed single ownership file and its limit: a size cap of 3 MB beyond which the file is not loaded (excerpt).

**Quality bar.** Same governed set on every clone of a commit; two developers adopting different files in parallel merge without a conflict that needs a human.

**Cost and scale.** Read: the lock refresh after each change hashes every governed file (`state/governed_lock.ts`, document 02). A flat file of 10,000 entries at about 100 bytes each is about 1 MB; of 50,000 entries about 5 MB, above the CODEOWNERS cap if that ceiling were adopted. Expected, not measured.

**Large-repo bar.** 100 developers, 10,000 or more governed files, parallel adoption merges cleanly.

| Option | Evidence | Weakness |
|---|---|---|
| Per-clone store plus one committed flat lock (today) | Code read | One file that every adopt changes; the store itself does not travel |
| Committed governed set sharded by top-level directory, one file each | Precedent: nested gitignore files, per-directory ownership | More files; a rule for where an entry lives is needed |
| Shared index service | Glean, SCIP central indexing (excerpts) | Needs a server and operations; unnecessary if a local index takes seconds (finding 4) |
| Commit the whole store | None found | A binary blob that cannot merge |

**Best way.** Keep the store local and rebuildable. Commit a sharded governed set (path, component id, hash) so adoption in different directories touches different files. Do not build a shared index service now, because the index rebuilds in seconds. Evidence level D for the sharding; not yet shown to improve results. Experiment: script 100 branches each adopting 5 random files, merge them into one, count conflicts for the flat file against the sharded layout.

**How we would know.** The merge experiment above; zero conflicts on disjoint directories; a second clone shows the same governed set.

**Verdict for Task 1.** A combination reaches the bar: per-file components for governance, a derived group label for naming, and a sharded committed set for sharing.

### Task 2. Discovering code and extracting symbols

**Quality bar.** The set of files indexed equals the set Git tracks (plus untracked, non-ignored files) for supported extensions; exported names are found with recall and precision of at least 95% (my threshold, replaceable by a source); the whole index finishes within the interactive tier (about 10 seconds) for 5,000 files. Large-repo restatement: the same at 50,000 files in the background tier with incremental updates in under a second.

#### 2.1 Which files are in scope

**Today.** `walkDir` and `shouldIgnore` in `manifest/indexer.ts` skip any path segment named `node_modules`, `.git`, `.purix`, `dist`, `build` or `.turbo`, and treat `.gitignore` and `.purixignore` as literal prefixes. Experiment E3 on a plain directory tree (not a Git repository) with `src/build/tool.ts`, `src/dist/emit.ts`, a `.gitignore` glob with a negation, a nested `.gitignore` and a symlink: `build` and `dist` sources were not indexed (wrong when they are real source folders), `src/gen.generated.ts` was indexed despite `*.generated.ts` in `.gitignore` (wrong), `pkg/sub/deep.ts` was indexed despite a nested ignore file (wrong), `keep.log.ts` was indexed (right, by accident), the symlink was skipped (fine). Measured.

**What it should do.** The gitignore format supports nested files, negation, `**`, directory-only patterns and the rule that nothing is re-included under an excluded parent (kernel.org manual, excerpt). Reimplementing it is a known source of drift; asking Git is exact by definition.

**Cost and scale.** `git ls-files` over 15,000 files was inside the E5b timings (a few hundred milliseconds of the 30 seconds). Measured as part of the parse-only run. Memory is the file list.

| Option | Evidence | Weakness |
|---|---|---|
| Hand-written walk with a name list (today) | E3: 3 of 5 cases wrong | Wrong in both directions: skips tracked folders, indexes ignored files |
| A gitignore library | Gitignore manual, excerpt | A second implementation to keep equal to Git; per-language packages differ |
| `git ls-files --cached --others --exclude-standard` | Git's own behaviour | Needs a Git repository; outside one, no answer |
| Git list inside a repository, today's walk elsewhere | Combination | Two code paths, but the second is rare |

**Best way.** Use Git's file list inside a repository and the existing walk with its name list outside one. Evidence level B for the problem (E3 measured), C for the fix (Git's documented behaviour); the fix itself was not run. Experiment: rerun E3 with the Git list and require the indexed set to equal the tracked set for supported extensions.

**How we would know.** E3 passes with zero differences against `git ls-files` on the fixture and on the six public repositories.

#### 2.2 Extracting symbols

**Today.** `extractSymbols` is one regular expression over `export (async )?(function|class|const|let|interface|type) NAME`; for Python it adds `^(async )?(def|class) NAME` with underscore names skipped. If a file yields nothing it records one whole-file record whose name is the path (`manifest/indexer.ts`). Measured on public repositories against the TypeScript compiler (`createSourceFile`, top-level statements with an export modifier or export specifiers) and Python `ast` (top-level functions and classes, non-underscore):

| Repository | Files | Whole-file fallback | Reference symbols | Recall |
|---|---|---|---|---|
| got (TypeScript) | 90 | 72.2% | 204 | 77.0% |
| nest (TypeScript) | 2,185 | 39.2% | 2,891 | 76.5% |
| typeorm (TypeScript) | 3,617 | 34.8% | 3,787 | 73.2% |
| flask (Python) | 83 | 21.7% | 556 | 100% |
| requests (Python) | 37 | 24.3% | 203 | 100% |
| django (Python) | 2,936 | 31.4% | 9,232 | 100% (9,231) |

By category in the TypeScript repositories: `export function`, `class`, `const`, `interface`, `type` found at 92% to 100% in got and nest; in typeorm `interface` 50.6% and `type` 41.4% (the misses I sampled are `bson.typings.ts` and `typings.ts`, declaration files; I did not confirm the cause is `export declare`). `export default`, `export { x }`, `export { x } from`, `export * from`, `export enum`, `export abstract class` and `export namespace` were 0% in every repository. In nest, 442 `export * from` lines and 155 re-export lines are the barrel files; the real definitions are found in the files they point to, so recall of definitions is higher than recall of exports. Precision (false positives) was not measured.

**What it should do.** Use the language's own syntax tree. SCIP builds one indexer per language on the compiler's tooling and names every symbol with a stable string id (Sourcegraph announcement, excerpt). GitHub's navigation uses tree-sitter queries for definitions and references, and calls it search-based and approximate against compiler-based precise navigation (GitHub blog, excerpt). Aider ships tree-sitter tag queries for more than 25 languages and builds its repository map from them (clone, `aider/queries/`, directory listing read; `repomap.py` searched, not read in full).

**Cost and scale.** In E5b, TypeScript `createSourceFile` plus `preProcessFile` over nest, typeorm and django cost 0.5 to 0.9 s per 1,000 files warm (per-file cost is higher on vscode: 2.5 s per 1,000, larger files). Measured. Memory: one file's tree at a time.

| Option | Evidence | Weakness |
|---|---|---|
| Regex (today) | E2: 73% to 77% recall on TypeScript; 100% on Python top-level | Misses default, barrel, enum, abstract; 35% to 72% of TypeScript files become whole-file records |
| TypeScript compiler `createSourceFile` for TypeScript and JavaScript, Python `ast` for Python | E2 used both as reference; E5b measured TypeScript cost | Python needs a Python process; one provider per language; the TypeScript package must be present (the provider already needs it) |
| tree-sitter tag queries for everything | GitHub, Aider (excerpts, clone listing) | Query quality varies by language; licence of Aider's query files not checked; adds a native or WASM dependency |
| Full compiler indexers (SCIP-style) | Sourcegraph announcement, excerpt. Second session ran scip-typescript on zod's main package: 332 files in 37.5 to 37.9 s over three runs, a 15.1 MB index with definitions and references (about 0.11 s per file) | About 50 to 250 times the per-file cost of the parse-only run (0.4 to 2 s per 1,000 files); I did not parse the index or compare its symbols with the compiler truth; needs the project to build; one indexer per language |

**Combination.** None of the single options reaches 95% recall on TypeScript except the compiler-based ones. A cascade fits: compiler syntax tree where a provider exists (TypeScript, JavaScript, Python), tree-sitter tags for other languages, regex only as the last resort. Evidence for the cascade is the cost and recall of its first stage; the later stages were not run.

**Best way.** Replace the regex with the syntax-tree extractors for TypeScript, JavaScript and Python now (and fix `$` and aliased exports if the regex is kept in the interim, which is a smaller, certain gain), and add tree-sitter tag queries or SCIP indexers when the first Java, C# or Go provider is built; SCIP is the better choice only where precise references are needed, because of its cost. The second session's pointer stands: put extraction behind the language provider interface, with the regex as the fallback. Keep the whole-file record only for files with no declarations. Evidence level B for the first stage (reference extractor measured at 100% by construction, cost measured); C for tree-sitter; the new extractor's precision against an independent reference was not run, so this is not yet shown to improve results. Experiment: rerun E2 with the new extractor against a hand-checked 200-file sample, and count false positives.

**How we would know.** Recall at least 95% against the compiler on exported declarations in every repository, and the whole-file fallback below 10% of files.

#### 2.3 What indexing costs, and when verification belongs

**Today.** `runIndex` calls `verifyInSandbox` once per supported file; each call copies the project and compiles it. The index row is "fail" if any file failed. The `incremental` and `full` options exist in the signature and are never read, so both flags do nothing (`manifest/indexer.ts`). Measured with the real `runIndex` on a synthetic chain of files, three repetitions each:

- 10 files: 27.4, 24.6, 24.5 s (2.45 to 2.74 s per file)
- 20 files: 57.7, 46.7, 40.0 s (2.00 to 2.89 s per file)
- 40 files: 86.5, 84.0, 86.2 s (2.10 to 2.16 s per file)

Earlier documents report 10 files 21.6 s, 20 files 48.0 s, 40 files 126.7 s, 80 files 390.5 s. My 10- and 20-file results match theirs; my 40-file result is 40 s faster and I did not run 80. I do not know why; their fixture may have differed (file size, imports). The claim "grows with files squared" is therefore not supported by my range and not refuted beyond it. What both agree on is that the cost is per file and large.

The parse-only alternative (read each file, list its imports, count its exports; no verification), three repetitions, mean of three with the first, cold repetition shown:

| Repository | Files | Runs (s) | Warm run per 1,000 files |
|---|---|---|---|
| requests | 37 | 0.61, 0.01, 0.00 | n/a |
| got | 96 | 2.11, 0.42, 0.42 | 4.4 s |
| flask | 83 | 0.08, 0.01, 0.01 | 0.1 s |
| django | 3,048 | 3.81, 0.61, 0.39 | 0.13 s |
| nest | 2,193 | 3.98, 1.18, 0.84 | 0.38 s |
| typeorm | 3,621 | 4.95, 1.23, 1.19 | 0.33 s |
| vscode | 15,359 | 53.81, 31.40, 30.54 | 2.0 s |

This is the table form of a measurement, not an option table; the figures are mine.

My pass rule for the alternative was "time per file within 2x across sizes and under 10 seconds for 5,000 files". The second holds for the repositories I ran at that size (django, nest and typeorm, about 1 to 5 s cold) and holds for vscode only by extrapolation (30.5 s for 15,359 files is about 10 s for 5,000, an estimate). The first fails on its face: small repositories show 0.1 to 4.4 s per 1,000 files because of start-up cost, and vscode is 2.0 against nest's 0.38 (larger files). I judge the intent met (it scales roughly linearly and is seconds to tens of seconds) and say that the strict rule as written failed.

**What it should do.** Mature tools bound cost by hashing inputs and doing only affected work. Nx hashes task inputs and rebuilds only what changed (excerpt). Zoekt reads each repository once to build trigram shards, which cost about three times the corpus size on disk (design document, excerpt). Glean writes stacked immutable databases so cost follows the size of the change (Meta engineering post, excerpt). SCIP lists incremental indexing as future work (announcement, excerpt). Aider keeps a per-file tags cache in a disk cache backed by SQLite (`repomap.py`, excerpt; I did not confirm what the cache key is).

**Cost and scale.** Today: time per file about 2 to 3 s plus whole-project copy (disk and CPU). At 5,000 files a linear estimate is 3 to 4 hours (expected, not measured). Proposed: seconds to tens of seconds, memory one file at a time, disk the cache (a few hundred bytes per file; see section 4.1).

| Option | Evidence | Weakness |
|---|---|---|
| Verify every file at index time (today) | E5: 2.1 to 2.7 s per file | Hours at large scale; an unrelated broken file marks the whole index failed (finding 9) |
| Parse-only index, verify at adoption or at first change | E5b measured the parse stage; ADR-068 already adopts on demand | Index says nothing about whether code builds; `purix check` must say so honestly |
| Parse-only plus a per-file content-hash cache | Nx, Aider (excerpts) | Needs a hash per file; `git ls-files -s` gives blob ids for tracked files without reading them |
| Background full verification on a schedule | Tier T3 in document 02 | Needs a worker; results arrive late |

**Combination.** Parse-only index (T2), content-hash cache so a rebuild reads only changed files, verification at adoption or at first change for the files that matter, and full verification as a background or CI job (T3 or T4). Each stage handles only what the earlier one does not claim.

**Best way.** Make the index parse-only and move verification to the moment a component is adopted or first changed; keep a background job for repository-wide verification. Make `--full` and `--incremental` real. Evidence level B for the parse cost and for the current cost (measured); D for the incremental cache, not yet shown. Experiment: change 1% of files in nest and measure the rebuild with the hash cache against the full parse (target under 1 second).

**How we would know.** Index of 5,000 files under 10 seconds on the CI machine class; rebuild after a 1% change under 1 second; `purix status` says "indexed, not verified" for files that were never built.

**Verdict for Task 2.** A combination reaches the bar: Git's file list, syntax-tree extractors with a tree-sitter fallback, and a hash cache, with verification moved off the index. The single options each miss: the regex misses a quarter of exports, the walk misses Git's rules, per-file verification misses the time bar.

### Task 3. Dependency edges

**Quality bar.** For owned components, the recorded edges include at least 90% of true import edges between them (my threshold), the set is the same on every clone, and anything that consumes edges (cascade, neighbour context, impact) receives them without the model's help. Large-repo bar: computing the reverse edges of one component takes under 100 ms at 50,000 files.

#### 3.1 Where edges come from

**Today.** Only `scaffold.ts` (copying the model's `plan.depends_on`) and `linkComponents` (`manifest/store.ts`) write edges. `adopt.ts` writes both lists empty. `addDependent` maintains the reverse list. Consumers: `getDependents` in `verify/impact.ts` reads `depended_on_by`; `reVerifyCascadeDependents` in `manifest/commit_and_cascade.ts` calls it; `recovery/escalate.ts` builds neighbour context from both lists. Experiment E1: index and adopt `rates.ts`, `total.ts`, `report.ts` where `total` imports `rates` and `report` imports `total` and `rates` (three true edges): recorded 0; `getDependents(rates)` returned nothing. Measured.

**What it should do.** Derive edges from the code. Nx builds its project graph from package files and import statements (excerpt). SCIP and Kythe record reference edges between symbols and definitions (excerpts: Kythe's schema is anchors linked to semantic nodes by labelled edges, produced by language indexers). Aider ranks files by PageRank over a definition-and-reference graph, personalised to the files and identifiers in play (`repomap.py`, `networkx.pagerank` with a personalization dict; excerpt).

**Cost and scale.** Import extraction on six repositories (counts are import statements, not de-duplicated): nest 4,336 edges, typeorm 11,910, django 1,142 (relative imports only), vscode 152,639. Between 98.5% and 100% of relative imports resolved to a repository file. Time is part of the E5b timings. Reverse-edge lookup on demand is a scan or a map built in the same pass; memory for vscode would be 150,000 small records. Measured for the extraction; expected for the lookup.

| Option | Evidence | Weakness |
|---|---|---|
| Model-declared at create, nothing at adopt (today) | E1: 0 of 3 | Edges exist only for created components and are whatever the model said |
| Reuse the import scan already in `verify/test_discovery.ts` (second session's proposal; I read the file header this session) | The file scans JS and TS imports by pattern, follows `tsconfig` paths and `baseUrl`, cannot follow bare package names, over-matches comments, skips `out`, `coverage` and `.next`, and stops at 20,000 files with a `truncated` flag | Rescans per call today; JS and TS only; the 20,000-file stop is below the target scale; it belongs to the verification session's domain, so the two documents must agree on one shared graph |
| Import graph from a lexer (`ts.preProcessFile`, a regex for Python) | E5b: 98.5% to 100% relative imports resolved | Misses package-name imports between workspace packages, TypeScript path aliases, Python absolute imports (the usual Python style), dynamic imports |
| Import graph from the compiler's module resolution | Nx and Kythe style, excerpts | Needs the project to resolve; slower; the TypeScript program is the expensive part |
| SCIP or Kythe indexers | Excerpts | A per-language indexer, build required; heavy |
| Build-system graph (Bazel, Nx, Gradle) read as a provider | Nx excerpt | Only where such a build exists; Java, C# and Go shops usually have one, which is why it matters for the target buyer |

**Combination.** The lexer graph covers relative imports cheaply; it must be joined by alias and workspace resolution to reach 90% on real monorepos, which is the ordinary shape of a large TypeScript repository. For Java, C# and Go the build-system graph is the better first stage; I have not researched those ecosystems.

**Best way.** Compute edges from imports at index time, share the one graph with test selection (the second session's point, which I accept: two scanners will drift) rather than keep two scanners, and keep it as derived data in the index, not written into each component row. Keep the model's `depends_on` only as an annotation, labelled by source, and never let it override a derived edge. Start with relative imports and the nearest `tsconfig` paths; add workspace package names next. Evidence level B for the extraction (measured count and resolution rate); level D for the claim that this reaches 90% of true edges, because I did not compare against compiler-resolved truth, and Python absolute imports were not resolved. Experiment (E1 for the new method): run the TypeScript compiler's module resolution on nest and typeorm and compare edge sets; require at least 90% recall and report precision.

**How we would know.** The E1 comparison; and `getDependents` on an adopted file returns its real importers.

**Verdict for Task 3.** The bar costs more than a lexer, so a combination: lexer edges first, alias and workspace resolution second, build-system graphs for other ecosystems. Document 02's cascade cost model applies only after this exists.

### Task 4. Storing the model

**Quality bar.** Reading the model for one lookup costs time that does not grow with the number of unrelated components; a crash never leaves a half-written model; two writers never both commit the same version; the store can be rebuilt from the repository and the committed set. Large-repo bar: lookup under 100 ms with 50,000 components and a 100,000-symbol index.

#### 4.1 Schema and size

**Today.** One table, whole entries as JSON text (`manifest/store.ts`); the index row holds every symbol record inside it. `listManifest()` parses every row, including the large index row, on each call. Writes use `BEGIN IMMEDIATE` and an optimistic version check through `json_extract(data,'$.current_version')`; the database runs in WAL mode with a 5-second busy timeout. Measured sizes and times (3 repetitions; `listManifest` and `resolveTarget`, milliseconds, 2 CPUs):

| Components | Index symbols | Database | `listManifest` | `resolveTarget` |
|---|---|---|---|---|
| 1,000 | 10,000 | not recorded (WAL not flushed) | 16, 16, 26 | 13, 10, 7 |
| 10,000 | 10,000 | not recorded (same reason) | 83, 46, 57 | 67, 88, 79 |
| 10,000 | 100,000 | 26.2 MB | 255, 292, 147 | 134, 63, 49 |
| 50,000 | 100,000 | 39.8 MB | 321, 370, 307 | 567, 206, 217 |

The database size is the main file only, after the write; the two small rows were not checkpointed and I do not report them. From the two 10,000-component rows and the 26.2 MB figure, an index symbol costs about 250 bytes and a 100,000-symbol index row is about 25 MB. SQLite's default limit for one text value or row is 1,000,000,000 bytes (`sqliteLimit.h`, `SQLITE_MAX_LENGTH`, excerpt), so the row would be refused at about 4 million symbols by this arithmetic (an estimate, not a test). Document 02 measured a manifest parse at 118 ms for 50,000 synthetic components; my 307 to 370 ms for 50,000 components plus a 100,000-symbol row is the same order once the index row is included.

**What it should do.** Look up by key. SQLite supports indexes on columns and on JSON expressions; Glean stores facts keyed for fast lookup and Zoekt stores per-shard indexes (excerpts). The model does not need to be parsed whole to answer "who owns this file".

**Cost and scale.** Measured above. Memory for the parsed index row at 100,000 symbols is a tree of objects several times the 25 MB text (expected, not measured).

| Option | Evidence | Weakness |
|---|---|---|
| One table of JSON blobs, index inside one row (today) | E7 | Every call pays for the whole row; 147 to 292 ms at 10,000 components exceeds the hook budget |
| Separate `symbols` and `edges` tables with indexes on name and file; component rows stay small | SQLite capability; Glean, Zoekt designs (excerpts) | A schema migration (version 5 to 6); two write paths |
| SQLite FTS5 for symbol and path search | SQLite feature, not read for this research | Extra index size; stemming and tokenising choices; I did not read the FTS5 page |
| Separate index file from the manifest | Combination | Two files to keep consistent |

**Best way.** Move symbols and edges to their own indexed tables, keep component rows as they are, and make the index row a small summary. The lookup then reads rows by key. Evidence level B for the table itself: the second session measured a `symbols` table with indexes on name and file at 250,000 symbols (lookup 0.018 ms, replace one file's symbols 2.0 ms, open plus first query 0.3 ms, full rebuild 762 ms, five repetitions) and I re-ran its script: lookup 0.016 to 0.017 ms, one-file replace 2.0 to 2.1 ms, rebuild 810 ms at 250,000 (182 ms at 50,000). Its one-row read was 274 ms at 50,000 symbols and 1.0 s at 250,000 with about 670 MB of memory; my 147 to 292 ms at 100,000 symbols plus 10,000 components is the same order on a faster machine. Not yet shown inside Purix itself: the migration and the resolver reading from the table were not built. Experiment: repeat E7 after the migration and require `resolveTarget` under 100 ms at 10,000 components and 100,000 symbols, three repetitions. A schema change needs an ADR.

**How we would know.** E7 rerun against the 100 ms line at 10,000 and 50,000 components.

#### 4.2 Location and sharing

Covered in 1.2. One more measurement bears on it: with a parse-only index (finding 4), each clone rebuilds its own index in seconds, so the store is a cache. That removes the main reason to share it.

**Verdict for Task 4.** One concept is enough once the migration is done: indexed tables in the existing SQLite store. Sharing is solved in Task 1.2, not here.

### Task 5. Finding the component an intent means

**Quality bar.** For an intent that names a target in words an agent or developer would use, the system returns the correct component first or a short list containing it, and returns a single confident wrong target at most 5% of the time (my threshold). Large-repo bar: the same at 50,000 components, in under 100 ms.

#### 5.1 Resolving an intent

**Today.** `extractMentions` tokenises the intent and adds 2- and 3-word kebab joins. `resolveTarget` scores component id 300, file path 200, symbol name 100; symbols are exact, case-sensitive, at least four characters, and count only if an owning component exists. `change.ts` runs this first; if nothing matches it takes the first mention for which `lookupAdoptable` says "adoptable" and offers to adopt; only then does it try a model-assisted extraction (verbatim-filtered). ADR-063 and PURIX-10 disagree on whether indexed symbols resolve; the run decides: indexed-but-unowned symbols do not resolve in `resolveTarget` (they need an owner) and reach the user only through `lookupAdoptable`.

Experiment E6: intents are real commit subject lines from six public repositories (commits that changed 1 to 3 supported source files, all still present at the current head; ground truth is the changed files); 300 per repository except typeorm, which yielded 38 under the filter. Two flows with the real functions: A, a fresh index with nothing adopted, where the code takes the first adoptable mention; B, every file adopted, where `resolveTarget` runs. A BM25 baseline over path and symbol words ranks files from the same index. Counts are shares of intents.

| Repository | A correct | A wrong | A none | B correct | B wrong | B none | B several (correct inside) | BM25 top 1 | BM25 top 5 |
|---|---|---|---|---|---|---|---|---|---|
| requests | 9.7% | 8.3% | 82.0% | 12.0% | 7.7% | 75.0% | 5.3% (3.0%) | 28.3% | 51.3% |
| flask | 7.3% | 1.3% | 91.0% | 6.7% | 3.7% | 83.3% | 6.3% (4.3%) | 25.0% | 45.7% |
| got | 2.0% | 7.7% | 90.3% | 2.3% | 13.0% | 79.3% | 5.3% (2.7%) | 20.0% | 47.3% |
| nest | 4.3% | 11.0% | 84.3% | 2.7% | 6.7% | 16.3% | 74.3% (18.3%) | 24.0% | 46.7% |
| typeorm (n=38) | 0.0% | 13.2% | 86.8% | 0.0% | 13.2% | 23.7% | 63.2% (36.8%) | 23.7% | 60.5% |
| django | 11.7% | 23.3% | 59.0% | 4.7% | 7.7% | 21.7% | 66.0% (30.0%) | 30.0% | 53.3% |

This table reports a measurement, not options. Flow A also has a small "only ambiguous" share (0.3% in flask and nest, 6.0% in django). Reading it honestly:

A commit subject is not an agent's intent; many subjects ("fix typo", "update docs") name no code. The "none" shares are therefore too pessimistic for deliberate instructions and I do not claim they describe agent use. The ground truth is strict: a "wrong" single answer may name a file that is related but was not changed. The Flow B component ids are slugs I built from file paths, not the ids `purix adopt` would derive, and the large "several" shares in nest, typeorm and django come from those ids matching generic words, so I do not rely on those columns. What does not depend on those caveats: exact matching rarely fires on this kind of text; when it does fire as a single answer it is wrong 1.3% to 23.3% of the time in flow A (the first-mention rule) and 3.7% to 13.2% in flow B; and a lexical baseline over the same words ranks the right file first about twice as often as the exact route finds it at all. My pass rule (wrong-single at most 5%; at least as good as BM25) failed.

External evidence on retrieval, all at excerpt depth: SWE-bench's own BM25 retrieval recalled the files that the real patch edits for 29.58% of instances at a 13,000-token context, 44.41% at 27,000 and 51.06% at 50,000 (averaged over instances), and a model resolved 1.97% with BM25 context against 4.8% with the oracle files (SWE-bench paper via ar5iv). CodeRAG-Bench reports BM25 at 57.7 NDCG@10 averaged and dense retrievers at 61.7 to 67.0 (arXiv 2406.14497). Agentless localises hierarchically (file, then class or function, then edit location) and resolved 32.00% of SWE-bench Lite at $0.70 per issue (arXiv 2407.01489). Aider personalises a PageRank over files to the files in the chat and identifiers mentioned, within a token budget whose default is 1,024 (`repomap.py`, excerpt).

| Option | Evidence | Weakness |
|---|---|---|
| Exact id, path, symbol match; first adoptable mention (today) | E6 | Finds the target rarely on free text; first-mention rule produces confident wrong answers |
| Exact match, but require every matching mention to agree and a unique owner | Own reasoning (D) | Lowers wrong-single, also lowers correct-single; not run |
| BM25 over path, symbol and import-neighbour words, return top 5 | E6 baseline (B); BM25 numbers from SWE-bench and CodeRAG-Bench (A, excerpt) | Top 1 only 20% to 30% here; needs a picker |
| Dense embeddings of files or symbols | CodeRAG-Bench, 4 to 9 NDCG points over BM25 (excerpt) | Needs an embedding model, an index to keep fresh, a data-leaving decision for large companies |
| Graph ranking over the import graph personalised by the mentions (Aider style) | Aider source, excerpt | Needs Task 3 edges; not measured here |
| Model reads the candidates and picks (Agentless style) | arXiv 2407.01489, excerpt | Model tokens per change; I could not run it |

**Combination.** No single option reaches the bar. A cascade: exact id or path match proceeds directly (cheap, safe); a unique exact symbol proceeds only if it is the only matched target across all mentions; everything else goes to BM25 over path, symbol and neighbour words and returns the top five. In MCP the picker is the calling agent, so "several" costs one turn, not a human prompt. The model-assisted tier stays for intents with no lexical hit.

**Best way.** Adopt the cascade. Replace "first adoptable mention" with "all mentions must point to one file". Add the BM25 stage over an index that contains paths, symbols and the group label. Evidence level B for the measured baseline and for the failure of the current rule, A for the external BM25 numbers; the cascade as a whole is not yet shown to improve results. Experiment: rerun E6 with the cascade and require wrong-single at most 5% with a correct file inside the returned top five for at least 60% (the BM25 top-five range here is 46% to 61%; I set 60% as a target, not a source figure). Include intents written for the purpose by someone other than me.

**How we would know.** E6 rerun on intents not taken from commit subjects, from at least one real design-partner repository, with wrong-single reported separately.

#### 5.2 Retrieval cost

**Today.** `resolveTarget` loops over every mention and every manifest entry and every owned path, and for every matching symbol does a linear search for its owner (`manifest.find`). Measured inside E6 (mean over 300 intents): requests 0.7 ms (37 components), flask 1.2 ms, got 1.6 ms, nest 45.7 ms (2,185), django 56.2 ms (2,937). In E7 at 10,000 components, 67 to 88 ms; at 50,000, 206 to 567 ms. Measured. It runs in the hook path only if the hook resolves; I did not trace whether `hooks/run.ts` calls it (not read).

**Best way.** Build maps by id, path and symbol once per process (or use the indexed tables of 4.1) and look up by key. Evidence level C. How we would know: E7 rerun, `resolveTarget` under 100 ms at 50,000 components.

**Verdict for Task 5.** A combination reaches the bar if the experiment confirms it: exact match as the fast path, BM25 as the net, the agent or a model as the picker.

### Task 6. Keeping the model true

**Quality bar.** A name the code no longer has does not resolve; a renamed or deleted file does not leave an owner behind; status words mean what they say; paths mean the same wherever the command runs.

#### 6.1 Drift, rename, delete

**Today.** `purix check` compares governed files to the lock and reports drift; the resolver does not. Experiment E9: rename `fetchRate` to `loadRate` in an indexed, adopted file without re-indexing. The old name still returned a single owner with score 110; the new name returned none. Measured. Delete and rename paths in `lifecycle.ts` were not read.

**What it should do.** Check the owning file before answering. Content hashes already exist for governed files (`state/governed_lock.ts`, `state/hash.ts`), and Git can report renames (`git diff --name-status -M`, Git's documented option).

**Cost and scale.** One file hash and one single-file parse per resolved candidate: milliseconds (E5b parsed 15,359 files in 30 s, about 2 ms per file). Measured as the parse rate.

| Option | Evidence | Weakness |
|---|---|---|
| Trust the index until the next full run (today) | E9 | Silent stale answers |
| Verify the owning file's hash at resolution and re-extract that file if changed | Own reasoning (D); parse cost measured | One file read per candidate |
| Watch the file system and update on change | Not researched | A daemon; platform differences |
| Rebuild the whole index before each change | Cost in Task 2 | Seconds at best, hours today |

**Best way.** Verify the owning file's hash at resolution and re-extract that single file when it differs; use Git rename detection on commit to move ownership. Evidence level D; not yet shown to improve results. Experiment: rerun E9 and require the old name to return nothing and the new name to return the file.

**How we would know.** E9 passes; a rename test moves the component with its file.

#### 6.2 Status wording and the index row

**Today.** The index row's `verification_status` is "fail" if any component failed. `check.ts` (`verificationSection`) walks every manifest row including the index, so a failed index row becomes "purix-codebase-index: its last verification failed", and `purix check` fails. Experiment E10: one broken ungoverned file produced "Check failed: 2 problem(s) across 4 governed component(s)", one problem being the index row. Adopted rows show "pending, not tested". `status_view.ts` (MCP) excludes the index row via `INDEX_ROW_ID`; `evidence.ts` includes it. Read and run.

**Best way.** Exclude the index row from every status, check and evidence reader through one shared predicate. Record unreadable or unverifiable files as an "indexed with problems" list on the index, not as a failing component. This is a bug fix with no ADR change. Evidence level B (run); the fix was not run. How we would know: E10 rerun gives "Check passed" with a broken ungoverned file.

#### 6.3 Path base

**Today.** `extractSymbols` uses `relative(process.cwd(), filePath)`; `runIndex` uses `relative(baseDir, ...)` for `files`. E4: run from the parent, `file_location` is `proj/src/a.ts` and `files` has `src/a.ts`. Adopt's language lookup (`index.components.find(r => r.file_location === file)`) and the resolver's owner match compare the two. Measured.

**Best way.** Pass `baseDir` into `extractSymbols`. Store paths relative to the repository root (the Git top level) in every record. Evidence level B. How we would know: E4 rerun; a test that indexes from the parent and from inside, and expects identical records.

**Verdict for Task 6.** Three separate fixes; each is one concept and enough on its own.

### Task 7. The operation library

**Quality bar.** An entry is reused only when it means the same change; tampering or corruption is detected; the size is bounded; and verification of integrity actually runs.

#### 7.1 Chain, eviction and the key

**Today.** `manifest/library.ts` (ADR-043) keys each entry by a sha-256 of component id, operation and a normalised instruction, links entries in a hash chain, and caps each language at 50,000 entries with least-recently-used eviction. `promoteOperation` upserts on conflict and rewrites `prev_hash` and `hash`. `verifyLibraryChain` has no caller outside its own test. `verifyExistence`, used by `listLibrary`, has no production caller and would treat a component id as a path. Experiment E8, using the real functions: after four inserts the chain verified; after re-promoting an existing entry it failed (index 0, "Broken prev_hash"); after evicting only the oldest row it failed the same way. `computeTaskSignature` gives the same key for text that differs only in whitespace or letter case, and a different key for a paraphrase or a changed value. Measured.

**What it should do.** Tamper evidence that survives pruning. The audit chain in this code base prunes with a checkpoint (`pruneAuditChain`, called from `state/scheduler.ts` line 183; I did not read the pruning code in this session, so I treat it as a pointer, not a verified design).

| Option | Evidence | Weakness |
|---|---|---|
| Chain plus eviction as built | E8: breaks | Verification is never run, so nobody sees it |
| Drop the chain; keep a per-row hash | Own reasoning (D) | No ordering evidence; only per-row tamper evidence |
| Chain with a checkpoint written at eviction (the audit-chain pattern) | In-house precedent, not read | Needs the checkpoint to be verified in turn |
| Append-only log with periodic compaction and a signed head | Not researched | More machinery than the benefit shown |

**Best way.** Keep the chain, add a checkpoint at eviction and re-promotion, and call `verifyLibraryChain` from `purix check`. Evidence level D; not yet shown to improve results. The larger open question is whether the library helps at all: I measured nothing about reuse. Experiment: replay real intents from a design partner's history through `computeTaskSignature` and count repeated keys; if under a few percent, reduce the library to a plain cache and drop the chain. ADR-043 needs ratification either way, because its two behaviours do not hold together.

**How we would know.** E8 passes after update and eviction; `purix check` reports a library chain result.

**Verdict for Task 7.** Narrow the claim until a reuse rate is measured: say the library is a cache with integrity checking, not a source of reuse.

### Task 8. Scale and many developers

**Quality bar.** The numbers in Tasks 2 to 5 hold at the target scale: 1,000,000 lines, tens of thousands of files, 100 developers.

**Cost and scale in one place (mixed measured and expected).**

- Index: today about 2.1 to 2.7 s per file (measured to 40 files); about 0.4 to 2 s per 1,000 files for the parse-only index (measured to 15,359 files). Tier T2 for repositories to about 5,000 files; T3 beyond (vscode took 30.5 s warm at 15,359 files).
- Store: lookup 49 to 134 ms at 10,000 components with 100,000 symbols and 206 to 567 ms at 50,000 (measured); the index row is about 25 MB at 100,000 symbols (derived). Meets T1 (2 s), not T0 (100 ms).
- Retrieval: tens of milliseconds at thousands of components (measured).
- Many developers: per-clone stores and one committed lock (read). Lock refresh hashes every governed file on each change (read, document 02). Untested.
- Model tokens: none in the deterministic path; the model-assisted tier was not run.

**Large-repo bar.** The proposals in Tasks 2 to 6 bring the index to the interactive or background tier and the lookup to the instant tier; the lock merge and the model tier are unmeasured. I do not see evidence for two codebases: the differences (a shared cache, background workers) are configuration, consistent with the verdict in document 02.

**Verdict for Task 8.** The bar costs too much as built (per-file verification, whole-row parse), so the task changes by moving work: parse at index, verify at adoption, look up by key, share a governed set rather than an index.

## 4. How the picks fit together

One index pass reads Git's file list and each file's hash, extracts declarations with a syntax tree, and records import edges, a group label and a hash per file, in indexed tables of the existing SQLite store. Nothing is verified. Adoption verifies the file being adopted, attaches its sibling test and writes a component whose edges come from the index. A change intent goes through the cascade: exact id or path, unique symbol across all mentions, BM25 over paths, symbols and neighbour words, top five to the picker. Before answering, the resolver checks the owning file's hash and re-extracts it if it moved. The committed governed set is sharded by directory; every clone rebuilds its own index. The library is a cache with a checkpointed chain that `purix check` verifies. `purix check` ignores the index row.

Order of work, cheapest and most certain first: fix the path base and the index-row status leak (bug fixes, a day each); replace the walk with Git's list; replace the regex with syntax-tree extraction; make the index parse-only and move verification to adoption; import edges; indexed tables and the retrieval cascade; sharded governed set and library checkpoint. Each step has its own rerun of the experiment named above.

Decisions that need the person's ratification: ADR-068 (adopt on demand: its `process.cwd()` follow-up is confirmed, and moving verification from index to adoption changes what "indexed" promises); ADR-063 (the resolver: the run settles the conflict with PURIX-10, but the cascade changes what "single" means); ADR-043 (the library: chain and eviction conflict; and whether the library stays); ADR-042 (store location: adding a committed governed set changes what is shared); a new ADR for the schema change to indexed tables; and ADR-002 and ADR-036, carried from document 02. ADR-067 and ADR-069 were named in my protocol but I did not read their bodies, so I do not claim what they decide.

## 5. What this document did not settle

- Whether the cascade in 5.1 reaches the bar on intents written as instructions rather than taken from commit subjects, and in a large-company repository.
- The model-assisted extraction tier and the model-picks tier (no key).
- Java, C# and Go: extraction, edges and build graphs. Likely the buyer's languages and unresearched.
- Edge accuracy against compiler truth; Python absolute imports; TypeScript aliases and workspace names.
- Merge conflicts in the committed lock and in the proposed sharded set, at 100 developers.
- Whether the operation library gets reused at all.
- Incremental rebuild cost for the parse-only index.
- Windows and macOS.
- Symbol-level versus file-level components: whether a change should target a function, not a file. The code uses files; I did not research symbol-level governance.
- The precision of the regex extractor and of any replacement.
- Why my 40-file index timing is 40 s below document 02's.

## 6. Sources

Labels follow the handoff: primary (official documentation, source, peer-reviewed or named-group preprint), secondary (blogs, third-party write-ups), vendor-run (author benchmarked their own product). All web sources were read at excerpt depth.

**Primary**
- Git `gitignore` manual: https://www.kernel.org/pub/software/scm/git/docs/gitignore.html
- SQLite `sqliteLimit.h` (default maximum text or blob length): https://www.sqlite.org/src/doc/tip/src/sqliteLimit.h
- Kythe schema overview: https://kythe.io/docs/schema-overview.html
- GitHub Docs, about code owners: https://docs.github.com/en/enterprise-server@3.14/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners
- Backstage descriptor format: https://backstage.io/docs/features/software-catalog/descriptor-format
- Nx mental model: https://nx.dev/concepts/mental-model
- Zoekt design document: https://gerrit.googlesource.com/zoekt/+/master%5E/doc/design.md
- SWE-bench (Jimenez et al.), via ar5iv: https://ar5iv.labs.arxiv.org/html/2310.06770
- CodeRAG-Bench: https://arxiv.org/html/2406.14497v2
- Agentless: https://arxiv.org/abs/2407.01489
- Aider source (`aider/repomap.py`, `aider/queries/`), commit 5dc9490, 2026-05-22: https://github.com/Aider-AI/aider (read from a local clone; excerpt by search)

**Vendor posts (the operating companies, describing their own systems)**
- Sourcegraph, announcing SCIP: https://sourcegraph.com/blog/announcing-scip
- Meta engineering, Glean open source: https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/
- GitHub blog, precise code navigation and stack graphs: https://github.blog/2021-12-09-precise-code-navigation-python-code-navigation-pull-requests/

**Secondary (used only to locate something)**
- Aider repository map description: https://kitemetric.com/blogs/how-aider-indexes-your-codebase-for-ai-powered-code-assistance
- Stack graphs summary: https://www.plushcap.com/content/github/blog/github-introducing-stack-graphs

**Second session (read at excerpt depth by it, not by me):** DraCo, arXiv 2405.19782; RANGER, arXiv 2509.25257; scip-typescript and scip-python documentation; its experiment scripts `a_extract.mts`, `a_py.py`, `b_graph.mts`, `c_scale.mts`, `d_index.mts`, `e_symtable.mts` (included in `research-05-experiments/second-session/`).

**Own measurements (evidence level B), scripts in `exp05/`:** `e_walk_and_path.mts` (E3, E4), `e1_e9_e10.mts` (E1, E9, E10), `e2_symbols.mts` and `e2_py_ref.py` (E2), `e5_runindex.mts` and `e5b_parseonly.mts` (E5), `e6_retrieval.mts` (E6), `e7_scale.mts` (E7), `e8_library.mts` (E8). Public repositories were cloned read-only and parsed, never run.

## 7. Claims register

| Claim | Status | Basis |
|---|---|---|
| Indexing cost grows with files squared | Not supported at 10 to 40 files (about linear); unrefuted beyond | E5, three repetitions per size |
| Edges are empty for index and adopt | Confirmed | E1, code read |
| ADR-068 path follow-up | Confirmed | E4 |
| Resolver symbols need an owner; ADR-063 vs PURIX-10 | Resolved by run: unowned symbols reach the user via `lookupAdoptable` only | `resolver.ts`, `change.ts`, E6 |
| `--incremental` and `--full` do nothing | Confirmed | `indexer.ts` read; no reader of the options |
| Library chain survives update and eviction | False | E8 |
| Library chain is ever verified in production | I did not find a caller | grep |
| "Trace what reads the indexer's pass status first" (handoff) | Done: `check.ts`, `evidence.ts`, CLI status view read it; MCP `status_view.ts` excludes it | E10, code read |
| Hook parse 118 ms at 50,000 components (document 02) | Not contradicted; my figure with a 100,000-symbol index row is 307 to 370 ms | E7 |
| 40-file index 126.7 s, 80-file 390.5 s (document 02) | Not reproduced on my chain fixture (84 to 86 s at 40); second session's zod runs (18, 38.4, 128 s at 5, 10, 20 files) are superlinear. Cost depends on the project | E5; second session |
| Symbols table lookups about 0.02 ms, replace about 2 ms at 250,000 | Reproduced by me | second session's `e_symtable.mts` |
| zod recall 63.6% against compiler-declared exports | Direction reproduced (my reference: 57.3%); `$` names are an extra cause | second session; my `e2_symbols.mts` |
| scip-typescript: 332 files in 37.5 to 37.9 s | Second session's measurement, not re-run; I do not have the zod clone's package build | second session |
| DraCo: +3.43% exact match, +3.27% identifier F1 | Second session's reading of the paper (excerpt); I did not read it | second session |

## 8. Corrections to earlier documents

- Documents 00 to 03 and the handoff: replace "indexing grows with files squared" with "indexing costs 2 to 6 seconds per file, from per-file whole-project verification; two independent sessions measured it, one roughly linear on tiny synthetic files (2.1 to 2.7 s per file to 40 files), one superlinear on zod subsets (3.6 to 6.4 s per file, 5 to 20 files)".
- Document 02, task 2.5 (cascade) and its cost model: the cascade and neighbour context have no edges to act on for adopted components; the cost estimate holds only for created components with model-declared edges.
- Handoff, status table, row "Component model, store and retrieval": change from "Not started" to the status in section 0 of this file, and replace the seed "indexing measured at files squared" with the finding above.
- Handoff, section 11: add the twelve findings in section 0 of this file.

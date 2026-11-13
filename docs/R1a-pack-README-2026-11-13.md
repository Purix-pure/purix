# R1-a pack for the merging session, 2026-11-13

Built from my merged tree (`tree3`), checked on Linux with stand-in tools. After today's edits I re-ran only the transform tests (39 of 39 pass), the CLI project-root test (5 of 5), `tsc --noEmit` for core (clean) and `check-claims` (ok, 149 rows). The full suites last ran on the 2026-11-11 tree, before these small edits. Not run on your tree, because I have not seen it.

## Why you could not find F05-07

F05-07 has no code of its own. It is a finding ("paths in the index depend on where the command runs"), and the command line already fixes it: `cli.ts` moves to the project root (the nearest folder with `.purix`, else `.git`) before any command except `connect`. That rule is already in `packages.zip`. So there is nothing to search for under that name.

What exists for it:
- One new test in `packages/cli/src/cli.project_root.test.ts`: `purix index` typed in `src/deep` records `src/app.ts` and leaves no `.purix` in the subfolder. It passed on its first run, so it pins existing behaviour; it is not a red-then-green fix.
- A fix block on the `F05-07` row in `claims.json`, in `claims-rows/rows-to-merge-by-id.json`. It says plainly that a library caller of `runIndex()` with no folder, typed from a subfolder, still follows the current folder.

## What is in the pack

| Folder | Holds |
| --- | --- |
| `files/` | 19 files, my final versions. Copy these in, or merge them (see below) |
| `r3-original/` | The running session's own versions of its 17 code and test files, before my merges |
| `base-packages-zip/` | The `packages.zip` originals of the files that already existed there, for a three-way merge |
| `claims-rows/rows-to-merge-by-id.json` | Four rows to merge into `claims.json` by id: F02-04, F05-06, F04-05, F05-07. Never merge `claims.json` as text |

The R1-a content: F05-06 (git's own file list in `indexer.ts`, `fileListSource` in the result), Python time budgets and the "did not answer" wording (`python.ts`, `python.pack.ts`, `python_test_integrity.ts`), BOM in the Python symbol reader and the anchor matcher, CRLF in anchor replacements and AST transforms, and locks stamped in the future (`config.ts`, `repo_lock.ts`).

## How to merge onto your tree

1. 12 files are the running session's own, untouched. Where your tree still equals `packages.zip` for a file, copy mine over it. Where you changed the file too, run `git merge-file yours base-packages-zip/<file> r3-original/<file>`.
2. Three files I hand-merged against other sessions: `verify/anchor_match.ts`, `verify/ast_transforms.ts`, `verify/python_test_integrity.ts`. If your tree has none of the C, G or round 2 work, take `r3-original/` for these three instead and ignore my versions.
3. `docs/WHAT_PURIX_CHECKS.md`: regenerate with `node scripts/generate-checks-page.mjs`, then `--check`.
4. Build core, mcp-server, cli in order; run the three suites, `check-claims` and the repository checks.

## Changes made today on top of the 2026-11-11 tree

- `ast_transforms.ts`: removed the ts-morph `newLineKind` setting (it duplicated `matchLineEndings`).
- `ast_transforms.ts`: `add_error_handling` now keeps a leading directive such as `"use server"` outside the retry loop and refuses a body of only directives. New file `ast_transforms_directive.test.ts`; 2 of its 3 tests failed first.
- Claims: F04-05 has a third reading (`partly_fixed`, probed) and a corrected fix block; F05-07 has its fix block.

## Still open

- The F02-01 and F02-02 disagreement is not settled here. Reading both notes, F02-01 is `partly_fixed` (index no longer verifies; first change still copies and compiles) and F02-02 is `still_holds`, but I did not time either, so I left their rows as they were.
- F03-09 and F04-04 independent reads still judge code C3 changed afterwards.
- F00-07's `not_covered` text is still a copy of F03-05's.
- Walk mode still reads `.gitignore` as literal prefixes.

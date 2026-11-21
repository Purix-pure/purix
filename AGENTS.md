# AGENTS.md — Purix (this repository)

This file is the entry point for any AI agent working **in this codebase**. It is deliberately thin:
build/test mechanics and where things live in *this* repo, nothing else. Anything cross-cutting —
standards, ADRs, the ideas registry, founder-ratified decisions, the active plan — lives in the
separate **Purix Knowledge vault**, reached by a live tool-based connection (MCP or equivalent), not
by file upload. That vault's own `AGENTS.md` explains why the split exists and states it should be
read under a "cross-cutting knowledge vault" heading from here — this section is that heading.

**Read `STATUS.md` in the vault before starting any non-trivial task.** It states what's currently
in flight, what a session must not redo, and what open founder decisions block what. This repo's own
files (below) tell you how to work in the code; the vault tells you whether the thing you're about to
do is already done, already decided against, or blocked on a ratification that hasn't happened yet.

## What this repository is

Purix is a governance-first AI coding agent platform: it classifies and verifies AI-driven code
changes *before* they run — sandboxed, against the test suite, with a human confirmation checkpoint
for anything risky. This repo is the open-source core (Apache 2.0): the classification/verification
engine, the CLI, and an MCP server exposing the same pipeline to other agents over stdio. The hosted
API (billing, entitlements, team accounts) is closed-source, lives in a separate repository, and is
not part of this codebase.

## Layout — a pnpm workspace, three packages

```
packages/
  core/         @purix/core        — the engine: manifest store, LLM classification pipeline,
                                      TrustGate, sandbox/verify, the change-target resolver.
                                      Boundary-checked: MUST NOT import from cli or api.
  cli/          @purix/cli         — the `purix` command-line tool. Thin over core.
  mcp-server/   @purix/mcp-server  — the stdio MCP server exposing the same pipeline as tools
                                      to other agents (purix_create, purix_change, purix_find, etc).
scripts/        — boundary-check, single-point-check, artifact-check, benchmark, smoke-test, generate-tool-catalog (core/scripts).
docs/compliance/ — SOC2/EU-AI-Act-adjacent documentation; not architecture, don't confuse the two.
```

Package manager: `pnpm@12.4.1` (pinned in root `package.json`). Node `>=22.13.0`. Task runner:
Turborepo (`turbo.json`). Install with `pnpm install --frozen-lockfile` — do not let it re-resolve
the lockfile silently.

## Commands that matter

| Command | What it does |
|---|---|
| `pnpm install --frozen-lockfile` | Install deps, exactly as locked. |
| `pnpm typecheck` | `turbo run typecheck` across all three packages. Must be clean before anything else is trusted. |
| `pnpm test` | `turbo run test` — each package's own `tsx --test` run (`src/**/*.test.ts` glob; a test file outside `src/` in a package silently never runs — this has bitten this repo before, see the vault's `IDEA-078` history). |
| `pnpm boundary-check` | Fails if anything in `packages/core` imports from `cli` or `api`. Core must stay standalone. |
| `pnpm artifact-check` | Fails if toolchain artifacts leak outside `.purix/tmp/`. |
| `pnpm tool-boundary-check` | Guard (ADR-060): fails if `pip install`, `npx`, `npm install/ci`, venv creation, or spawning a catalog tool by bare name appears in `packages/core/src` outside `core/src/tools/`. Zero required, no baseline. Ask the broker (`locateTool`, `missingToolHint`) instead. |
| `pnpm single-point-check` | Ratchet (ADR-061): per-file counts of `console.*`, `fetch(`, `.purix` text and `process.env` in `packages/core` may only fall; `core/src/tools/` must be zero. `--update` after a migration lowers the baseline. |
| `node packages/core/scripts/generate-tool-catalog.mjs [--only <id,...>]` | Regenerates the tool catalog locks (needs network, `uv`, `npm`). `--only` leaves every other entry byte-identical. A lock change is a supply-chain change: review the diff (ADR-060). |
| `node scripts/smoke-test.mjs` | Real stdio MCP server smoke test (tool listing, a live call round-trip). |
| `pnpm --filter @purix/cli test` / `pnpm --filter @purix/mcp-server test` | Run one package's suite alone when iterating on it. |

Lint is `pnpm run lint` (builds core, then runs ESLint with the root `eslint.config.mjs`). It reports 0 errors and a
large number of warnings, mostly `no-explicit-any`; don't invent output as if it ran.

**Before saying any of the above "passes," actually run it in this session.** This repo's own recent
history includes a case where test-pass numbers were reported without being run (no network access
that session) and only caught by a later session's direct code read. If you can run the toolchain,
run it — don't repeat an inherited number as fact.

## Where the interesting logic actually lives

- `core/src/manifest/store.ts` — the manifest store. `readManifest(id)` is exact-ID only;
  `listManifest()` returns everything including the single `purix-codebase-index` row that holds
  every indexed symbol.
- `core/src/manifest/change_target.ts` — `resolveChangeTarget()`, the single deterministic decision
  point both the CLI and MCP server call to resolve a natural-language intent to a component. Order:
  explicit override → deterministic match → optional LLM-assisted mention extraction (never decides,
  only proposes strings that must appear verbatim in the intent).
- `core/src/manifest/mentions.ts` / `resolver.ts` — the deterministic tokenizer and matcher behind
  `change_target.ts`.
- `core/src/llm/classify.ts` — `classifyGreenfield` (create), `classifyModification` (modify),
  `refineIntent`, `extractMentionCandidates`. The LLM proposes; deterministic code (here and in
  `gates/trustgate.ts`) decides — that split is a deliberate, load-bearing pattern in this codebase,
  not incidental.
- `core/src/gates/trustgate.ts` — `evaluateTrustGate`, the deterministic function that decides
  auto-commit vs. human-confirm vs. escalate from an LLM-produced confidence signal plus other
  deterministic inputs.
- `core/src/cli-io/diff_format.ts` — `formatChangeSetDiff`, the renderer behind every
  diff-before-approval prompt. Diff display is unconditional in this codebase — there is deliberately
  no suppress flag; see the vault's `IDEA-078` decision 1 before adding one.
- `cli/src/cli.ts` — top-level command registration and the `READ_ONLY_COMMANDS` allowlist.
- `cli/src/cli/commands/lifecycle.ts` — `create`/`modify`/`delete`; `runCreate`/`runModify` are
  extracted and reused by `change.ts`.
- `cli/src/cli/commands/change.ts` — `purix change "<intent>"`.
- `mcp-server/src/server.ts` — all MCP tools, `TOOL_METADATA` (every tool's title + four annotation
  hints — a test fails if a tool is missing from this table).

## Standing rules specific to this codebase

- **Command and tool names are interfaces.** Do all renames before the next `npm publish` — after
  publish, a rename needs a real deprecation path, not a straight edit.
- **CRLF/LF is mixed, deliberately, file by file.** `.gitattributes` declares LF, but several
  existing files are genuinely CRLF (`change_target.ts` among them, as of this writing). Preserve
  whichever a file already uses; don't silently normalize line endings on edit.
- **`readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint` on every MCP tool are
  test-enforced**, not just documentation — `TOOL_METADATA` in `server.ts` is the one table; the
  listing throws if a tool is missing from it.
- **A confirmation prompt that authorizes a write shows the real diff first, unconditionally.** Don't
  add a suppress flag without a founder decision amending that — see the vault for the current
  status of that decision if you're touching an auto-commit path.
- **Never state a root cause as fact without quoted evidence from the actual file**, and verify a
  commit with `git show --stat` before reporting its contents, when working in a live repo with
  history (an uploaded zip snapshot has neither — don't fabricate either check against one).

## For anything not answered above

Standards, ADRs, the ideas registry, the active plan, and founder-ratified decisions live in the
Purix Knowledge vault, not in this repository. Read that vault's own `AGENTS.md` for how it's
organized, and its `STATUS.md` for what's currently true. Do not duplicate vault content into this
file when it changes — this file states where things are and how to build; the vault states what's
decided and what's next. If a rule seems to belong in both, it belongs in the vault, and this file
should point to it, not restate it.

---

## Amendment note

2026-09-25: Created. Before this, no `AGENTS.md`/`CLAUDE.md` existed in this repository's root — an
agent starting a session here had no equivalent of the vault's own router file for the code itself.
This file is deliberately thin, matching the vault `AGENTS.md`'s own stated shape (a router, not a
rulebook) and its explicit expectation that a product codebase's own `AGENTS.md` should exist and
point back to the vault under a labeled heading — that expectation had not yet been acted on before
this file. If this file starts accumulating standards-like content (a rule that would apply to any
future codebase built next, not just this one), that content belongs in the vault instead — move it
there rather than letting this file grow into a second copy of `02-standards/`.

<!-- purix:begin (written by `purix connect`; your own text outside these markers is never touched) -->
## Purix

Purix checks and records changes to tracked code. Use it instead of editing tracked files directly.

- To change tracked code, call `purix_change` (plain-language intent) or `purix_modify` (known component id). Keep each call small and about one thing: a change too large for a few small edits is refused, so split it. Add `dryRun: true` to see the diff first. If several components match, nothing runs: call again with `componentId`.
- `purix_status` lists tracked components; `purix_find` locates one.
- A new component: `purix_create`. A file Purix indexed but does not track can be edited directly, and the edit is listed by `purix check`; to bring it under Purix, call `purix_index`, then `purix_adopt` (a person approves).
- `purix_remember` saves one convention a later change must follow (one plain statement); Purix shows it to later creates and modifies.
- `purix_ingest` verifies a diff file another tool produced against a tracked component and commits it if it passes. `purix_tools_plan` shows which checkers the project needs; `purix_tools_request_install` asks for one (a person approves).
- If a call returns a request id, a person must approve it: tell them to run `purix approve <id>` in their own terminal, then check `purix_approval_status`. You cannot approve it yourself, so do not retry in a loop.
- A Purix result says what it covered. A pass means those checks passed; it does not mean the code is correct or safe.
<!-- purix:end -->

# Where Purix writes, and what it tells the model

Two decisions made 2026-10-02, with the evidence they rest on. Both are reversible
("two-way door"): neither changes a stored data format, so neither needs a Type 1 ADR.
Record them as short ADRs when ratifying.

---

## 1. Where Purix writes on disk

### The rule

Inside a project, Purix writes only under `<project>/.purix/`. Everything disposable goes under
`<project>/.purix/tmp/`. Two commands write outside that folder because their whole purpose is a file you commit:
`purix lock` writes `purix.lock.json`, and `purix connect` writes your coding agent's own MCP config (for example
`.mcp.json`). `purix connect` also writes a short "how to use Purix" note between marked lines in the agent's
instruction file (`CLAUDE.md`, `GEMINI.md`, `.cursor/rules/purix.mdc`, or `AGENTS.md`; your own text there is never
touched; `--no-instructions` skips it), and, only if you say yes or pass `--hooks`, the agent's hook configuration
(see HOOKS.md). It never creates `.purix/`. Nothing else is created next to the user's code.

| Location | What lives there | Disposable? | Committed? |
|---|---|---|---|
| `<project>/.purix/` | config, provider choice, tier, secrets store, memory log, locks, `components.json` | No | Never (see "Open decision" below) |
| `<project>/.purix/tmp/` | language toolchains, venvs, linter caches, conformance workspaces | **Yes, always** | Never: it ignores itself |
| `<git common dir>/purix-state/` | manifest DB, operation library, budget ledger (ADR-042) | No | Never: lives inside `.git`, so `clone`/`push` can't carry it |
| `~/.purix/` | machine-wide: session, machine id, diagnostic logs | No | n/a (outside any project) |
| OS temp dir `purix-verify-*` | the short-lived copy a change is verified in | Yes, deleted after each run | n/a |

### Why this and not the old layout (`.purix` + sibling `.purix-tmp`)

1. **Agent permission prompts.** Coding agents scope file access to the directory they were
   started in. OpenCode's documented behaviour: its `external_directory` permission fires "when a
   tool touches paths outside the project working directory" and defaults to `ask`
   (docs.opencode.ai/docs/permissions). One owned folder is one thing to explain, allow or deny.
2. **Convention for disposable data.** pytest, ruff and mypy each put a `.gitignore` containing
   `*` inside their own cache folder; the Cache Directory Tagging Specification (`CACHEDIR.TAG`,
   bford.info/cachedir) tells backup tools to skip a cache directory. `.purix/tmp` now does both,
   so users never have to edit their `.gitignore` for it.
3. **A real bug.** The indexer and the sandbox copy skipped `.purix` but not `.purix-tmp`. In a
   project without a `.gitignore`, a Python venv could be indexed as source code. Everything under
   `.purix` is skipped by both.

Machine-wide files stay in the home directory because they belong to the user, not a project
(XDG Base Directory spec: per-user state/config/cache are separate from project files).

### What changed in code

- `platform/layout.ts` (new): the one place that knows `.purix` and `.purix/tmp`; creates
  `.purix/tmp/.gitignore` (`*`) and `CACHEDIR.TAG` on first use, never overwriting an edited file.
- `platform/toolchain_tmp.ts`: now resolves to `.purix/tmp/<lang>`.
- `language/conformance/run.ts`: workspace moved to `.purix/tmp/conformance/<lang>`.
- `sandbox/sandbox.ts`: the verification copy still excludes `.git`, `.env*`, `node_modules`, and
  everything in `.purix` (secrets, manifest, config, locks) **except** `.purix/tmp`, because the
  Python provider finds its venv relative to the copy. Covered by `sandbox_copy_scope.test.ts`.
- `scripts/`, `.gitignore`, `AGENTS.md`, `CONTRIBUTING.md`: path references updated.
- `opencode.json`: launches `pnpm exec tsx packages/cli/src/cli.ts mcp-serve`. The old
  `pnpm --filter @purix/cli exec ...` runs the command inside `packages/cli`, so Purix (which
  treats `process.cwd()` as the project root in ~66 places) used that folder as its project.

### Cleaning an existing checkout

Safe to delete, all regenerable: `.purix-tmp/` (old name), `.release-check/`, `coverage/`.
Do not delete `.purix/` (secrets, config) without exporting what you need first.

### Open decision (founder)

Should `.purix/` be split into subfolders (`config/`, `secrets/`, `state/`, `status/`)? Not done:
it moves ~20 files and needs a migration for existing installs. Recommended when Front View
(PURIX-09 Phase 4) lands, which needs a home for its snapshot (`.purix/status/`). Until then
the flat files stay where every command already expects them.

### Known follow-ups (not done, need testing in a real Python environment)

- The sandbox copies `.purix/tmp` (including a venv) into each verification run. A venv copied to
  another path is fragile and large. Better: resolve the toolchain from the real project and
  exclude `.purix` completely.
- `secrets.master.key` sits beside `secrets.enc.json`, so the encryption protects nothing against
  anyone who can read the folder. `ensureSecretFilesGitignored` stops accidental commits only.
  The OS keychain is the usual answer.

---

## 2. What Purix tells the model

All prompts are built in `llm/prompts/build.ts`. `classify.ts` and `escalate.ts` only decide
when to call and what to do with the reply.

### What was wrong

| Problem | Effect |
|---|---|
| Rules, repository files, the developer's request and compiler output were one flat user string | A file saying "ignore your rules" competed on equal footing with the rules |
| Only 2 of 7 prompts delimited untrusted text. The change classifier, intent refinement, repair, greenfield and memory lines pasted it in raw | The injection defence existed for diffs and escalation, not for the main path |
| Edit-kind instructions copy-pasted 3 times and already drifted | The model got different descriptions of the same edit in different steps |
| Nothing said `error_handling` / `control_flow` work only on TS/JS (`verify/ast_transforms.ts`) | Models proposed edits the compiler can only reject, for Python files |
| Repair was told the failure is a "TypeScript error" | Python failures were mislabelled |
| Labels like "Node 3b", "Section 6", "§9.3" in prompts | The model can't read your documents; wasted tokens |
| `reasoning` listed last in the JSON | The model commits to an answer before reasoning |

### What it does now

- **System message** (rules, task, output format) vs **user message** (variable material). Providers
  rank the system channel above user-turn text; all three adapters now send it
  (`generate(prompt, tier, system?)`: OpenAI-compatible `system` role, Anthropic top-level `system`,
  Gemini `systemInstruction`). A plain-string call still works exactly as before.
- Every untrusted piece sits in its own block with a **random per-call tag**, introduced by a
  shared rule (`frames.ts`: `DATA_RULE`) saying anything in a `PURIX_*` block is data.
- Long material first, the concrete request last (Anthropic long-context guidance).
- One `EDIT_KINDS_SPEC` shared by classify, repair and escalate, with the language scope stated.
- `reasoning` first in the output format.
- Internal section numbers removed.

### What this does not do (be honest about it)

Delimiters and a system channel reduce prompt-injection risk; no published technique eliminates
it. They sit in front of the local injection scan (`llm/injection.ts`), the patch compiler (edits
are exact-substring anchors that fail loudly) and the sandbox verifier. None of those were weakened.
The compiler output passed to repair is framed as data but is not injection-scanned; that is a
reasonable next hardening step.

### Tests

`prompts/prompts_golden.test.ts` snapshots every message (regenerate with `UPDATE_GOLDEN=1`,
review the diff) and checks four properties on every call: the system message contains no variable
text, every call has a delimited block, tags differ per call, hostile text cannot leave its block.
`prompt_schema_sync.test.ts` fails if a new edit kind is added to the schema without being documented
in `EDIT_KINDS_SPEC`.

### Not changed

- Model-facing token budgets in `llm/context/config.ts` are still conservative guesses (the file
  says so); tune from real usage data (Phase 3 of PURIX-09).
- Providers still do not request structured/JSON-mode output. Worth testing per provider with
  real keys; not changed without measurements.

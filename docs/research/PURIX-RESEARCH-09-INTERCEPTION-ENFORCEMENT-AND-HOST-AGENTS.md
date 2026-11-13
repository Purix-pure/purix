# Domain research 09: interception, enforcement and host agents

Prepared 2026-10-29. Number 09 is provisional: the plan gives no number to steps 6 and 7, and 07 and 08 are taken, so please confirm or renumber (rule C).
This document merges plan steps 6 (interception and enforcement) and 7 (host agents and the MCP surface), because the second is the evidence for the first.
Snapshot: code `d873c00c78b6822c` (`packages__2_.zip`, same pin as document 07), vault `purix-knowledge-working-2026-10-04`, research set as uploaded 2026-10-29.
Method: `PURIX-RESEARCH-METHOD-2026-10-29.md` plus Addendum B (M1 to M8). Evidence levels: A = run by me on the real code, B = read in the code or in a primary source, C = secondary source or a user report, D = reasoning only.

**Status: partly researched.** The probes are run and repeated. Two of six agents were read from their official documents in depth (Claude Code partly, Codex fully). The other four rest on excerpts, third-party tools or user reports. No real agent was run, so nothing here says what happens inside a live session. Section 6 lists what is missing and what each gap costs.

## 0. Read this first

**What this domain is for.** Stop an AI coding agent from changing files Purix governs except through Purix, and make sure the guard cannot be quietly switched off, skipped or worn out by timeouts.

**Findings, most important first.**

1. **The shell screen misses most ways to write a file it was meant to catch.** I fed the real decision function 45 cases (3 identical runs). Of 39 fair cases that should be blocked, 21 were blocked and 18 were let through. Four must-allow cases (`cat`, `grep`, `git status`, and a write to a different, differently cased file) were all correctly allowed (no false blocks). Level A, deterministic.
   - 10 misses are fixable defects: `python -c`, `node -e`, `ruby -e` and a Python heredoc are recognised as "can write" but the path inside the quoted code is never found; a variable (`F=src/auth.ts; echo x > $F`), a command substitution, a brace path, `cd src && echo x > auth.ts`, `curl -o` and `wget -O` also pass.
   - 6 misses no text screen can ever catch: a script file (`python3 fix.py`, `node fix.js`), `npm run codemod`, `npx prettier --write`, `eslint --fix`, and a base64 string piped to `sh`.
   - 2 misses are tool names: a write tool called `FileWrite` and an MCP file-writer (`mcp__filesystem__write_file`) are classed "other" and always allowed.
2. **The same gap lets an agent rewrite the hook's own config.** Of 8 ways to rewrite `.claude/settings.local.json`, 3 were blocked (redirect, `rm`, `jq` then `mv`) and 5 passed (`python -c`, `node -e`, a script file, `cd` then write, a variable path). Level A for the decision. What happens next inside Claude Code was not run. Claude Code's reference says edits to hook settings are picked up by a file watcher and that a `disableAllHooks` setting exists (level B).
3. **Timeouts and failures to start let the call through, on most agents, unless the entry asks otherwise.** Claude Code's reference: a timed-out `PreToolUse` hook does not block; any exit code other than 2 is non-blocking; the default timeout is 600 seconds; an `onFailure: "block"` field exists from v2.1.295. Purix's Claude entry sets no timeout and no `onFailure`. Its shell wrapper turns "purix not found" into a block, but not a hang (level B, code and docs).
4. **By default the guard protects one developer's machine, not the company.** The installer's default scope is `local` (an uncommitted personal file) for every agent except Antigravity (the user's home folder). It has no managed or organisation scope, and every vendor documents one (Claude managed settings with `allowManagedHooksOnly`, Codex `requirements.toml` with `allow_managed_hooks_only`, Gemini system settings, Cursor MDM; the Cursor one from a secondary source). Users can turn hooks off: Claude `disableAllHooks`, Codex `[features] hooks = false` unless an admin pins it, Codex skips a hook until the person trusts its exact definition (level B, docs and `install.ts`).
5. **The vendors themselves say hooks are not a wall.** OpenAI's Codex page: "Treat tool hooks as a useful guardrail, not a complete enforcement boundary," and hosted tools such as web search are not hooked. Anthropic's page says its `if` filter is best-effort and to use the permission system for a hard allow or deny. This agrees with finding 1 (level B).
6. **Cursor on Windows may block every edit.** One measured forum report (Cursor CLI, Windows): with `timeout: 10` the hook ran and answered, but the verdict was discarded at the deadline, and with `failClosed: true` that blocks allowed edits too. Purix's Cursor entry is exactly `timeout: 10, failClosed: true`. A second report says hooks did not fire at all. One user's reports, not reproduced (level C).
7. **OpenCode subagents may bypass the guard.** An open issue (version 1.0.182, December 2025) says plugin hooks fire for the main agent but not for subagents started with the task tool. Its status today is unknown. Purix's installer already prints this warning (level C).

**What is already good and should not be touched.** The decision logic is cheap and uses no model or network. Write tools are resolved through symlinks, `..`, `./` and absolute forms (all caught in my run). An unreadable write payload is denied, not allowed. `purix approve` and `purix deny` cannot be run by an agent. Exit-code answers match the documented contracts for Claude Code and Codex.

## 1. Gate table (rule A)

| Gate | State |
|---|---|
| 0 Snapshot pinned | Done (header). Vault is nine days older than the code and was not searched for hook ADRs beyond ADR-064 references in the code comments |
| 1 Protocol before searching | Done in this file's section 3 (tasks and bars set before the agent documents were read). The probes were written after reading `decide.ts` |
| 2 Sources with read depth | Section 5 |
| 3 Claims register | `research-09-experiments/claims-09.json` (14 claims); `scripts/check-claims.mjs` not run |
| 4 Run what picks name | Probes P1 and P2 run. The picks that need a live agent are not run |
| 5 Repeated measurement | P1 and P2: 3 runs, identical output (functions are deterministic, so this shows stability, not spread). No timing measured |
| 6 Try to break findings | Partly: I removed two of my own probes as unfair (a backslash path on Linux is a legal file name; the Task tool is not a write tool). Rule B not done |

## 2. What the domain is, today (level B, code read in full)

`purix hook <agent> <event>` is started by the agent before each tool call. `protocol.ts` turns each agent's payload into one shape; `decide.ts` decides; `run.ts` loads the governed list from the manifest (or the committed lock) and answers in the agent's style. Rules: a write tool on a governed or protected path is denied; a write tool with no readable path is denied; a shell command is split on `&&`, `||`, `;`, `|` and newlines and screened by a verb list, redirects and interpreter flags; `purix approve/deny/provider trust` are human-only; an unreadable pre-tool payload is denied; a `Stop` hook runs `purix check` for drift and, if it finds any, tells the agent (it cannot undo anything). Six agents have installer entries.

## 3. Tasks, concepts and the best way

Verdicts follow the method: ONE (one concept is enough), COMBO (a combination reaches the bar), CHANGE (the bar costs too much, so the task changes).

### Task 1. Decide which agent actions touch a governed file
**Bar.** A write to a governed file made through the agent's own write tools is always stopped; a shell write is stopped where a text screen can see it; the rest is caught afterwards.
**Today.** Finding 1. Write tools are strong (6 of 6 forms of a real write tool caught; the Windows backslash path needs a Windows run, and two tool names are missed, finding 1); the shell screen is a verb list with a path finder that fails on quoted code.
**Cost and scale.** One process start and a manifest parse per tool call. The handoff measured the parse at 118 ms for 50,000 components against a 100 ms budget (carried over, not re-measured here).
| Option | Evidence | Weakness |
|---|---|---|
| Keep the verb list, add verbs (`curl -o`, `wget -O`) | Level A for what it would catch | Never ends; base64 and script files stay open |
| Scan the whole command text for any governed or protected path, then deny unless the command is on a short read-only list | Level D (design). By reading, it would catch 8 of the 10 fixable misses; `src/{auth}.ts` and `cd` need extra handling | Over-blocks harmless commands that mention a governed file. Not tested |
| Treat shell writes as undetectable and rely on after-the-fact checks (Stop hook, CI) | Level B: both vendors say hooks are not a boundary | Detection comes after the damage; needs Task 4 |
| Move enforcement into the agent's own sandbox or permission rules | Level B: Anthropic points to the permission system | Different per agent; doc 01 covers sandboxing |
**Verdict COMBO.** Widen the screen by scanning the whole command text (a tripwire, honestly named), fix tool-name classification by input shape (any tool whose input carries a file path key is a write), and stop describing the hook as preventing shell writes. **What the evidence supports:** a direction (hooks are a first layer, not a wall; the miss list is mostly fixable). It supports no number such as "block 95% of shell writes". **How we would know:** re-run P1 after the change and add a corpus of real agent commands from logs; the tripwire's false-block rate on real commands is the cost and is not yet measured.

### Task 2. Keep the guard on, and make failure safe
**Bar.** If the hook cannot start, hangs, times out or is disabled, the person is told and, for governed work, the call is blocked.
**Today.** Findings 2, 3, 4, 6. Per agent, section 4.
| Option | Evidence | Weakness |
|---|---|---|
| Today: one shell wrapper that maps unexpected exit codes to a block | Level B | Hang and timeout still pass on Claude Code; wrapper uses POSIX shell syntax (on Windows without Git Bash, Claude's reference says a failed shell-form hook "can instead block the tool call"; not run) |
| Set `onFailure: "block"` on Claude Code entries and explicit short timeouts everywhere | Level B (Claude reference); Cursor already has `failClosed` | Needs v2.1.295 or later; short timeouts can cause the Cursor problem in finding 6 |
| A `purix hooks doctor` that fires a canary call at each installed agent and reports blocked or not | Level D | Needs a live agent; a third-party tool (`eval-magic`) records doing exactly this for OpenCode (level C) |
| Install through managed policy so users cannot disable it | Level B for each vendor's mechanism | Needs the company's IT to deploy; Purix can only generate the file |
**Verdict COMBO.** Fail-closed settings where the agent supports them, a canary check that proves a block was seen, and a generated managed-policy file for organisations. **Supported:** direction only. The right timeout number has no evidence: Claude's default is 600 s, Codex's 600 s, Gemini's 60 s, and Cursor's user report suggests a short value can backfire. **How we would know:** you run the canary on each agent on Windows and Linux and paste back what was blocked.

### Task 3. Who the guard protects (person, team, company)
**Bar.** A company can require the guard on every developer's machine and every agent session, and a developer cannot remove it.
**Today.** Finding 4. M5 (large-company evidence) is **not met**: I found vendor documents for managed policy but no first-hand report from a large engineering organisation on running agent hooks at scale.
**Verdict CHANGE.** Do not install into company machines. Generate the managed file for each agent (Claude managed settings, Codex `requirements.toml`, Gemini system settings, Cursor enterprise hooks) and a check that reports whether the managed copy is active. Codex notes that its managed hooks do not distribute scripts; the company's device tooling must (level B), which fits.

### Task 4. Catch what the hook missed
**Bar.** Every change to a governed file that bypassed Purix is found before merge.
**Today.** A `Stop` hook runs `purix check` (drift and lock) and cannot undo; CI can run `purix check`/`purix lock` (handoff, level B). The lock check was not run against the 18 misses.
**Verdict (unproven).** The design is sound and needs one experiment I did not do: take each of the 18 missed writes in a scratch repository and see whether `purix check` flags the file. Until then, "caught afterwards" is a claim about design, not a measurement. Required status check plus code-owner review with no bypass is documented by GitHub (carried from the handoff, level B).

### Task 5. Speed at the hook tier
Carried over: the parse is the cost, 118 ms at 50,000 components; Node start-up was not measured here. A tripwire that scans command text adds microseconds; the store parse is the real risk (document 05 task on store reads).

## 4. What each agent does (documents read; Purix's entry noted)

| Agent | What the hook sees and how it blocks | If it times out or fails | Scope and company control | Gaps and reports | Purix entry |
|---|---|---|---|---|---|
| Claude Code | `tool_name`, `tool_input` (path or command). Exit 2 or JSON deny blocks | `PreToolUse` timeout, can't start or other exit code does not block unless `onFailure: "block"`; default 600 s | Local, project, user, plugin, managed. `allowManagedHooksOnly`, `disableAllHooks` (managed ones immune) | Hooks also run inside subagents (official). A deny holds in bypass mode (secondary source only) | Matcher `Edit|Write|MultiEdit|NotebookEdit|Bash`: no PowerShell tool, no `mcp__*`. No timeout, no `onFailure` |
| Codex | `Bash`, `apply_patch` (patch text in `tool_input.command`), MCP and other local tools. Exit 2 or deny JSON | Unsupported output fields mark the run failed and the call continues; default 600 s | Hook must be trusted by hash first; project hooks load only if `.codex/` is trusted; `hooks = false` turns off; managed via `requirements.toml` | Hosted tools not hooked; "not a complete enforcement boundary" (official). Windows `apply_patch` input shape issue reported (user issue) | Matcher `Bash|apply_patch|Edit|Write`, timeout 10, Windows command override |
| Gemini CLI | `BeforeTool` on tool names. JSON `decision` deny, or exit 2 | Non-JSON stdout defaults to allow (official); behaviour on timeout not read; default 60,000 ms | Project, user, system, extensions; project hooks fingerprinted | MCP tools named `mcp_<server>_<tool>` | Matcher `write_file|replace|run_shell_command`, timeout 10,000 ms |
| Cursor | `preToolUse`, `beforeShellExecution`. Exit 2 or `permission: deny` | Other exit codes fail open unless `failClosed` (official excerpt) | Project, user, MDM-managed (secondary source) | Windows CLI: deny verdict discarded at timeout; hooks not firing (user reports) | `timeout: 10`, `failClosed: true` |
| OpenCode | Plugin `tool.execute.before`, block by throwing; no matcher, fires for every tool | A missing binary must be handled by the plugin | Plugin file in project or user config | Subagent bypass reported (old issue) | Plugin shim reading exit code |
| Antigravity | `PreToolUse` in `hooks.json`; decisions allow, deny, ask, force_ask | Fails closed on a missing or malformed decision (third-party live test, v1.1.2, 2026-07-13) | Global file or `.agents/` per project; the CLI is reported to ignore the project file | `allow` does not skip its own prompt (same source). Official documents not opened | Matcher `*`, timeout 10 |

## 5. Sources and read depth (first thing to check)

| Source | Read depth | Used for |
|---|---|---|
| Claude Code hooks reference (code.claude.com) | **Read, first part only** (up to `UserPromptSubmit`: config, matchers, exit codes, timeouts, `onFailure`, managed settings). The `PreToolUse` section was not reached | Findings 3, 4, 5; Claude row |
| Codex hooks page (OpenAI) | **Read in full** | Findings 4, 5; Codex row |
| Gemini CLI hooks reference and overview | Excerpts from search results only | Gemini row |
| Cursor hooks page | Excerpts only; two forum threads (user reports) | Cursor row, finding 6 |
| OpenCode | Third-party crate notes and one GitHub issue, excerpts; official plugin page not opened | OpenCode row, finding 7 |
| Antigravity | Third-party tool source (live-tested by its author); official documents not opened | Antigravity row |
| Four dev.to and blog posts on Claude Code hooks | Excerpts; secondary; used only to find what to check in the official page, except the bypass-mode claim, flagged as secondary | |
| Large-company report (M5) | **Not found** | |

## 6. What I could not check (and what it would cost)

- No real agent was run. Every "what happens next" is from documents. Cost to close: you run a canary on each agent (the doctor command, or by hand) on Windows and Linux.
- Claude Code's `PreToolUse` section, Gemini timeout behaviour, Cursor and OpenCode official pages, and any Antigravity official page were not read in full.
- The backstop (Task 4) was not run against the 18 misses.
- Windows: the backslash-path case, Git Bash versus PowerShell wrapper behaviour and Cursor's Windows reports need your PowerShell runs.
- The vault was not searched for ADR-064 or the hooks plan beyond what the code comments cite.
- No timing was measured. Rule B (another session re-running my probes) has not happened.

## 7. Changes to other documents (M7)

- **Document 08 (governance):** its floor finding (paths matched only for registered files, no separator or case normalising) and this document's Task 1 are the same weakness seen from two sides: the hook and the trust gate each hold their own path rules. Decide one shared matcher.
- **Document 07 (self-healing):** my independent re-run agrees with its findings 1, 2 and 6 (see `RULE-B-NOTE-07.md`).
- **Document 01 (sandboxing):** Task 1's fourth option depends on each agent's own sandbox; the Codex page lists sandboxing and approval pages not read here.
- **Document 05:** the 100 ms hook budget depends on its store-read figures.

## 8. What I need from you

1. Confirm the number 09 (and that steps 6 and 7 are one document).
2. A PowerShell run of a canary on any agent you use (Claude Code, Codex or Cursor first), and the output of `purix hooks status`.
3. Whether you can run Claude Code at v2.1.295 or later (the version that has `onFailure`).

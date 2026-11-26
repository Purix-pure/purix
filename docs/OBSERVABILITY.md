# Showing what Purix did

One record, four surfaces. Every surface reads the same stored events and model-call log through `packages/core/src/observe/ledger_reader.ts`, so a number in the agent is the number in the browser. The reader opens the database read-only and never writes.

| Surface | How to get it | What it is |
| --- | --- | --- |
| Result line | On every MCP reply for a change tool. Turn it off with `PURIX_RESULT_LINE=off`. | `Purix: 41 tests passed (2 skipped), 1 stopped, $0.03 spent, $1.97 left`. Left out when there is nothing to say, and never added to a JSON reply. |
| `purix watch` | A second terminal in the project. `--once` prints and exits. | Live events, and a `WAITING` line for each approval that needs you. It names `purix approve <id>`; it cannot answer one. |
| `purix statusline` | Claude Code runs it and passes JSON on stdin (`--range today\|7d\|all`). `purix statusline --install` adds it to Claude Code's settings. | `Purix today: 3 landed · 1 stopped · 41 tests · $0.42 of $5.00`. Prints nothing and exits 0 when nothing is recorded. |
| `purix dashboard` | Prints an address with a one-time token. `--no-open`, `--port`. | Local, read-only: all projects, one project (Results, Security, Time and flow, Cost; Timeline, Catches, Components, Spend, Evidence, Limits), a receipt per change, a "how it is computed" page, JSON export. |

### Installing the status line

`purix statusline --install` writes `"statusLine": { "type": "command", "command": "purix statusline" }` into `.claude/settings.local.json` (personal, this project). `--shared` writes the committed `.claude/settings.json`; `--user` writes `~/.claude/settings.json` for every project; `--uninstall` removes it; `--status` shows all three places. Rules it keeps:

- It never replaces a status line that is not Purix's. If one is set, nothing is changed and the command says what is there (exit 1).
- Every other setting stays, in its order. A settings file that is not valid JSON is refused, not repaired. Claude Code's settings files are strict JSON, so a comment or a trailing comma would be an error there too.
- Checked against Anthropic's documentation: the `statusLine` shape, the user and project locations, that the status line stays blank until the folder is trusted, and that output is shown only when the command exits 0 and prints something. **Run live, 2026-11-26, on Linux:** Claude Code 2.1.332 (npm), started in a clean environment with an isolated home, no model reachable, the folder pre-trusted, and the settings file exactly as `purix statusline --install` wrote it. Claude Code ran `purix statusline` (found on PATH) and passed JSON with `cwd`, `workspace.current_dir`, `workspace.project_dir`, `session_id`, `model`, `cost` and `context_window`, matching the documented shape; the footer showed `Purix today: 1 landed · 1 stopped · 12 tests` from stand-in events written through the core API. Note the same run printed nothing while the folder had no record, as documented. **Not checked:** a session with a real model, and Windows (the command is plain `purix statusline`, so `purix` must be on the PATH of the shell Claude Code uses). Run from inside another Claude Code session's environment, the nested Claude Code did not call the status line at all (its inherited `CLAUDE_CODE_*` variables changed its behaviour); a clean `env -i` start did. Re-checked 2026-11-25: the settings reference lists `statusLine` under "Any file", and the settings page lists `.claude/settings.local.json` as the project-local scope that applies over the shared file, so the personal default is a file Claude Code reads. If the line does not appear, use `--user` or `--shared`.

`purix feedback yes|no [changeId] [--reason wrong|slow|too-many-prompts|other]` records your own answer to "did this help?". It stays on this machine and is shown beside the measured numbers.

## What is stored (new in this round)

- **One change id** (`chg-…`) on every event and model call a change causes (`observe/change_context.ts`). An MCP tool call and a CLI command each get one.
- **Test counts and verification time** on each passing verification (`test_counts`, `verify_ms`). A run that reported none leaves the field out: absent means "not recorded", never zero.
- **`change_landed`** closes a change's record; **`approval_decided`** and `wait_ms` on `confirm_response` keep how long a person took.
- **`change_feedback`** holds your answer.
- **A project registry**, `projects.json` in the user folder: path, state folder, name, first and last seen, agent ids. No counts, no file names.
- **Schema version**: events written this round carry `schema: 1`; a row without it reads as version 0.

## The weekly digest

`purix digest [--days n] [--json]` (n from 1 to 90, default 7) sets the last n days beside the n days before. It is read-only and takes no repository lock. Because the record only starts at its oldest stored event (and events older than the log retention, 365 days unless changed in the scheduler settings, are deleted), a digest says so when the earlier period is not fully covered: a note names the date the record starts, and if the record starts inside the current period no "the period before" figure is printed at all. `--json` prints both periods' summaries, including `firstEventAt`, so every number can be recomputed.

## Two lines on the change receipt

- **Dependencies added**: what the dependency lookup stored for that change (package names added or raised, how many the registry did not know and which, exact versions with a known advisory, and how many got no answer). With the lookup off, or a change that adds no package, nothing is stored and the line says "not recorded". It never reads "none".
- **Rework risk**: whether Purix landed another change on the same component within 14 days of this one (the same rule as the project-level Rework number, asked about one change). It says "too recent to judge" until the window closes, never "none" early. It sees only changes made through Purix and is a correlation with later changes, not proof the first one was wrong.

## The result line's size

The line is capped at 120 characters (`RESULT_LINE_MAX_CHARS`). A typical line is about 70 characters. Purix has no tokenizer, so token figures use its own estimate of 3.5 characters per token: about 21 tokens for the typical line and at most 35 for the cap. Those are estimates; the character counts are measured. When a line would pass the cap, the least urgent parts are dropped first (budget left, then spend, then tests) and parts are never cut in half.

## Dashboard protections

Loopback only on a random port; the token is swapped for an HttpOnly, SameSite=Strict cookie; the `Host` header must be `127.0.0.1` or `localhost` on the server's port; GET and HEAD only, so nothing can write; no CORS headers; a Content-Security-Policy that forbids scripts, framing and form posts; a project is reached only by the id of a registry entry. `?redact=1` replaces project, agent, component and file names with aliases for screenshots.

## Rules the numbers keep

Every number is labelled measured, estimated or not measured and links to `/how`. Counts show what they are out of. Purix's own misses (failed verifications, runs with isolation `none`) are shown. "Saving against a plain agent" reads "not measured" until a side-by-side run exists, and there are no dollars for bugs prevented.

## Added in the 2026-11-24 round

- **OpenCode sidebar panel** (`purix panel --install|--uninstall|--status`, `--user`): one plugin file (`.opencode/purix-panel.tsx`) and one entry in OpenCode's `tui.json`. It shows the `purix statusline` line and runs that command every 10 seconds. For OpenCode 1.x. Checked: the plugin type declarations of `@opencode-ai/plugin` 1.19.6 (the source type-checks against them; a wrong slot name would NOT be caught, because slot names are loosely typed there), and, on 2026-11-25, a third-party TUI plugin reference that gives `.opencode/tui.json` and the global config folder as locations, an absolute path or `file://` URL as a `plugin` entry, `sidebar_content` as a slot name, and a default export with a required `id` for a file plugin (all as written here). **Known risk from OpenCode's own issue tracker:** reports #59458 (2.1.4) and #66252 (2.4.1) say a plugin slot may not repaint when its own state changes, until the host re-renders for another reason; both are open or closed as a duplicate of #39986 and were reported on 2.x builds. If the line stays stale in your OpenCode, that is the likely reason, not Purix; `purix statusline` itself is unaffected. **Run live, 2026-11-26, on Linux:** OpenCode 1.19.6 (npm) in tmux, isolated home, no provider connected, panel installed by `purix panel --install`. The plugin loaded, the sidebar showed a "Purix" block with the status line, and when a new event was recorded while OpenCode was open the line changed within the 10-second poll (so the repaint reports above did not reproduce on 1.19.6). In the narrow sidebar the line wraps onto a second row instead of being cut. **Not checked:** a session with a real model, Windows, macOS, and OpenCode's v2 plugin API (a different shape, not supported). It never replaces a file or entry it did not write and refuses a `tui.json` with comments.
- **`purix check` state on each dashboard card**: the dashboard runs `purix check --json --no-register` in each project's folder as a separate read-only process, in the background (two at a time, an answer reused for two minutes, 20-second limit). A card with no answer yet reads "checking" and the page reloads itself every 3 seconds until it has one; "could not be checked" is never shown as clean.
- **Per-agent split** inside a project page: landed, stopped and spend per agent id, with the number out of the total.
- **Changed-line coverage for Python** (pytest-cov, lcov, with branch information). pytest-cov is now part of the pinned, hash-checked pytest install; a project's own coverage thresholds are overridden so measuring can never fail a run. No report reads "not measured".
- **`purix lookup on|off|status`** and a one-time question at the end of `purix connect` (decision 3: stays off until a person says yes).
- **Pull-request receipts** (decision 1): see `docs/PR_RECEIPTS.md`.
- **Benchmark** (decision 2): a separate script, not a command. See `docs/BENCHMARK_PROTOCOL.md`.

## Not built yet

The saving against a plain agent is still "not measured": the analysis script and the paired-run runner (`scripts/benchmark-run.ts`) exist, but no one has run the runner with a real agent, so there are no paired runs. Changed-line coverage for languages other than JavaScript, TypeScript and Python: not built, because those languages have no provider in Purix (see BETA_SCOPE.md). Windows and macOS runs of everything on this page.

Built since an earlier version of this page: risky files by kind of file (`riskyFiles` in the summary, a line in the Security panel and in the digest; groups the files named by policy-block events by generic pattern such as `.env*` or `*.pem`, never by name; counts stops, not files), the dashboard's check cards finding the CLI from where the module lives instead of `process.argv[1]`, rework within 14 days, events for secrets removed, dependency lookups, audit runs and policy blocks, `purix digest [--days n] [--json]`, changed-line coverage for JavaScript, TypeScript and Python runs (on the receipt and in the Process panel), the optional duplication check (`PURIX_DUPLICATION_CHECK=1`, counts only, local), the four-week trend, the telemetry preview page (`/telemetry`), and `purix receipt` for pull requests.


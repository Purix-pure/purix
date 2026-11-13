# Hooks: how Purix enforces instead of advising

Status: **built and tested against a real store, a real CLI process, and a project made by the real CLI (`pnpm run ci-hook-flow`, six agents' payload shapes). Not yet run inside any real agent.** Until that run is on file (see "What is not verified"), do not describe hooks as proven in public copy.

## What it is

A hook is a small program an agent runs before it uses a tool. `purix hook <agent> <event>` reads what the agent is about to do and either allows it or blocks it with a one-sentence reason the agent can act on. It reads Purix's state read-only, uses no model and no network, and sends nothing anywhere.

**One engine serves every agent.** The decision logic (`decide.ts`) knows nothing about any agent. Each agent adds only a description: where its config lives, how its payload names the tool and the file, and how it wants to be told "no". Adding an agent is a table row, not new logic.

```
purix hooks install                 # every supported agent already used in this folder
purix hooks install codex           # or name one
purix hooks status
purix hooks doctor                  # check each installed hook; run a canary through the installed command
purix hooks uninstall codex
```

`purix hooks` is not listed in `purix --help`. It merges into the agent's config (your other hooks and settings stay as they were), refuses a config file that is not valid JSON, never overwrites a plugin file Purix did not write, and running it twice leaves one copy.

## Supported agents

| Agent | Where the hook goes | How it blocks | Trust or load step | Confidence in the format |
|---|---|---|---|---|
| Claude Code | `.claude/settings.local.json` (personal, default) or `.claude/settings.json` (`--shared`) | exit 2 + stderr | none | Anthropic's reference |
| Cursor | `.cursor/hooks.json` | `permission:"deny"` JSON and exit 2, `failClosed` | none | Cursor docs as quoted by others; reports of hooks not firing on Windows and in the CLI |
| Codex | `.codex/hooks.json` | exit 2 + stderr | **open `/hooks` and trust it once; until then Codex skips it silently** | OpenAI's hooks page |
| Gemini CLI | `.gemini/settings.json` | `{"decision":"deny"}` on exit 0 | project hooks are fingerprinted and may need review | Google's reference |
| Antigravity | `~/.gemini/config/hooks.json` (default; named group `purix`) or `.agents/hooks.json` (`--project`) | `{"decision":"deny"}` on exit 0 | restart the session | **third-party sources only**; one live-tested report |
| OpenCode | `.opencode/plugins/purix-guard.ts` (a plugin Purix owns) | the plugin throws | none | OpenCode plugin docs and write-ups |

The plugin for OpenCode, and the config commands for the others, all run the same `purix hook`. The Claude Code, Codex and Gemini CLI commands turn any exit code other than the engine's own into a block, because those agents treat a missing or crashed hook as "carry on". Cursor has `failClosed`; the OpenCode plugin throws when it cannot run the command. Antigravity is reported to fail closed on its own.

## What it blocks

| Attempt | Result |
|---|---|
| An agent file tool (Edit, Write, MultiEdit, NotebookEdit, `apply_patch`, `write_file`, `replace`, StrReplace, Delete, and the similar tools of the other agents) writes a file Purix governs | Blocked, naming the file and component and the Purix route (`purix change`, or the `purix_change` MCP tool) |
| A write tool targets Purix's own state, `purix.lock.json`, or any agent's hook configuration (project and user level) | Blocked: an agent cannot switch the hook off |
| A symlink, `./x/../x`, a relative or absolute path to any of the above | Resolved first, then blocked |
| A shell command that redirects into a governed or protected path, runs a write-capable command on it (including globs and parent folders), or **names it anywhere in a command that is not on a short read-only list** (inline interpreter code, a heredoc, a variable set earlier in the command, a `cd` before a relative path, `curl -o`, `prettier --write src/x.ts`) | Blocked. **A tripwire, not prevention**: it reads text, and the limits below stay |
| A tool the hook does not know by name (`FileWrite`, `mcp__filesystem__write_file`) whose input carries a file path; an unknown tool whose input carries shell text | Treated as a write, or as a shell command, and screened the same way. A tool whose name says it only reads (`Read`, `Glob`, `read_file`) and Purix's own MCP tools are left alone |
| A write to `.mcp.json`, `.vscode/settings.json`, `.git/hooks`, `.claude/skills`, `.claude/commands`, or a shell startup file in the home folder | Blocked as protected (they start programs or steer the agent) |
| A shell command that runs `purix approve` or `purix deny` | Blocked (`human-only`): those answer the agent's own pending MCP request, so only the person may run them, in their own terminal. `purix approve` also refuses to run without a terminal. |
| A shell command that runs `purix provider trust` or `purix provider set custom` | Blocked (`human-only`): they decide where the person's API key is sent, so only the person may run them. |
| A write tool call whose target file cannot be read from the payload | Blocked (cannot be checked) |
| The hook cannot read its payload, find the project, or read the store | Blocked for a pre-tool event; allowed for `Stop` so a bug cannot trap the agent |
| Governed files changed during the session by some other means | `Stop` (Claude Code and Codex) reports them, and the agent continues and tells the person. It reports; it cannot undo. |

A project with no store and no lock governs nothing, so ordinary edits are allowed; every agent's hook configuration is protected regardless. Agents that send only a working directory (Codex, OpenCode) are resolved to the project by walking up to the folder that holds `.git`, `purix.lock.json` or the Purix state.

Every block is recorded as a `hook_denied` event (agent, rule, paths; never file contents) when a store already exists. The hook never creates one.

## What it does not do (read this before making any public claim)

- **The shell screen is not a security boundary.** It is a tripwire and does not prevent shell writes. What still passes, on record as tests: a script file written first and run later (`python3 fix.py`), `npm run <script>`, an encoded string piped to a shell, a formatter run over a folder without naming a governed file (`prettier --write .`), a path built from pieces, and `git checkout main` (which rewrites governed files with no path in the command). Vendors say the same of their own hooks. The Stop-time check is the backstop where the agent has a Stop event. A command that only reads but names a governed file and is not on the read-only list is blocked too, which can be a false block; the rate on real agent commands has not been measured.
- Measured on research 09's probe `p1_shell_and_paths` (45 cases, a synthetic governed project, the real decision function, Linux, no agent): 20 of 41 should-block cases passed before this change, 4 after (the script-file, `npm run`, and encoded-string cases above), 0 false blocks on the 4 must-allow cases. That says what the decision function does with those inputs. It is not a block rate for real agents.
- It does not see edits made by a tool that is not an agent file tool or the shell: another MCP server that writes files, an editor extension, a build step.
- **Agent-side switches.** Codex can have hooks turned off or run with `--dangerously-bypass-hook-trust`; Antigravity is reported to skip hooks entirely in always-approve mode; OpenCode plugin hooks are reported not to see subagent calls. The agent-independent layers (`purix check` in CI, a git pre-commit check) are the answer to these and are not built yet.
- Enforcement exists only where the hook is installed and loaded. `purix hooks status` shows the config entry exists ("config present"); it cannot prove the agent loaded it. Restart the agent and try an edit to a governed file.
- It does not say anything is correct, safe or verified. It says the edit did not bypass Purix on the paths above.

## Why the install commands look the way they do

The Claude Code entry also sets `onFailure: "block"` and a 30-second timeout (a number chosen, not measured), because Claude Code's reference says a hook that times out or cannot start does not block otherwise. `onFailure` needs Claude Code 2.1.295 or later; an older client may ignore it. Its matcher now includes `PowerShell` and every `mcp__` tool, so each MCP call starts one `purix hook` process (latency not measured). Run `purix hooks install claude-code` again to upgrade an older entry; `purix hooks status` warns about one.

Claude Code treats only exit code 2 from a `PreToolUse` hook as "block"; a missing `purix` (exit 127) or a crash (exit 1) means "carry on". Codex and Gemini CLI do not document a fail-closed switch either. So their commands are a short POSIX shell snippet that maps every other exit code to a block, with a message saying the hook did not run. On native Windows that needs a POSIX shell, except Codex, which gets a separate PowerShell `commandWindows`. Neither Windows form has been run.

On "no objection" the exit2 and Cursor styles print nothing: in Cursor an explicit `allow` can act as a grant that skips its own approval prompt, and Codex accepts an allow only together with an input rewrite. Gemini CLI and Antigravity are given an explicit `{"decision":"allow"}`: Antigravity is reported to fail closed on a missing decision, and its own approval prompt still runs after an allow.

## `purix hooks doctor`

For each installed agent it (1) reads the config back and checks the fail-closed settings, (2) runs the **installed command string** through the shell with a **simulated** payload, a write into Purix's state folder, and reports whether a block came back in that agent's answer style, (3) runs it again with `purix` removed from PATH to show the wrapper blocks, and (4) tells you the live step: ask the agent to create `.purix/hook-canary.txt`, then run the doctor again; a file that appears there means a write got past the hook. Steps 2 and 3 do **not** show that a live agent loads the hook or honours the answer. On Windows the doctor does not run them and prints a PowerShell line to run by hand. Not yet run against any real agent.

## Trust gate on the MCP path (A9-1 follow-up)

MCP diff ingest applied no Deterministic Override Floor and logged no gate decision. Both MCP paths now call one shared step (`applyDeterministicFloor`) and record the decision. Guarded by a source-level test and unit tests of the helper; no end-to-end MCP ingest run against a floor path.

## What is not verified

| Item | Why | How to close it |
|---|---|---|
| Any real agent loads the config and honours the block, on any OS | Not run; payload shapes follow the vendors' documents or third-party logs | Run each agent once in a throwaway project and keep the payload log |
| Antigravity: write-tool names, the path key, and whether the CLI loads the global file | One logged payload (`list_dir`) was available; `write_to_file`/`TargetFile` are from memory | `agy` run with a payload log |
| Codex: that `apply_patch` always arrives as `tool_input.command`, and that trust is granted by `/hooks` | OpenAI's page says so; not run | Codex run |
| Cursor: which key holds the file path; hooks firing on Windows and in its CLI | Sources are third-party and forum reports | Cursor run on Windows and in the CLI |
| Gemini CLI: the shell tool's name, and whether empty output is accepted | The documentation examples use `write_file`/`replace`; the shell name is from memory | Gemini CLI run |
| The shell snippet and the PowerShell form on Windows | Not run | Windows run (`purix hooks doctor` prints the line) |
| Claude Code accepts `onFailure`, the 30 s timeout and the `mcp__.*` matcher, and blocks on a timeout | Written from Anthropic's reference; no client run | Claude Code 2.1.295 or later: run the doctor's live step, and a deliberately slow hook |
| False-block rate of the whole-command scan on real agent commands | Not measured | Replay a corpus of real agent commands (logs from the real-agent runs) |
| Hook latency on a large store | Reads component rows only (no integrity scan) but was not timed on a big project | Time it on the largest test project |

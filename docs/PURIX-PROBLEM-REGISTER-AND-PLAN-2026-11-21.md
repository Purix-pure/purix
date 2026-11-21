# Purix problem register and plan, 2026-11-21

Base: `packages.zip` (0.4.0-beta.4) plus the merged credential and message changes (see `PURIX-HANDOFF-2026-11-21.md`).
This file holds every problem found so far, every change that is required or suggested, and what is still open.

How to read the status column:
- **Fixed in tree**: the merged tree contains the change and it was tested.
- **Open**: found, evidence given, not changed. Needs your go.
- **Decision**: depends on a choice only you can make.

Evidence labels: **run** = I ran it and saw the output; **read** = quoted from the code, not run; **research** = from outside sources (listed at the end).

---

## 1. What to do first (short list)

1. **MCP: turn the dead end into a guided pause** (section 4). It is the biggest cause of "Purix stops and gives errors". All items are small to medium, and none of them loosens the approval rule.
2. **Beginner path: finish what exists rather than add `purix start`** (section 5). The front door already has a first-steps page and `purix connect`; the gaps are smaller than I first said.
3. **Run the real keyring on Windows, macOS and a Linux desktop** before release (section 6, X1). Nothing in this container could test it.
4. Restore the two deleted `security_gate` files in the test folder before the next user-test run (T1).

---

## 2. Problem register

### 2.1 Credentials (all fixed in tree, except where marked)

| ID | Problem | Evidence | Status |
|---|---|---|---|
| C1 | The key store followed the folder; a key saved in one folder was invisible from another | read: `projectStore()` built from `process.cwd()` | Fixed in tree: one user-level store, old per-folder store found by walking up |
| C2 | An old stored key beat a good environment key; the provider only said "API key not valid" | read: `getSecret(name) ?? dataDrivenEnv(name)` | Fixed in tree: environment first, then user store, then old store; the source is shown |
| C3 | Master key sat beside the ciphertext | read | Announced, not removed, in the file fallback. The OS keyring avoids it. |
| C4 | Webhook secret never read (name mismatch) | read | Fixed in tree: `PURIX_WEBHOOK_SECRET` |
| C5 | A question nobody could answer was reported as a refusal ("Bootstrap declined", "Cancelled") | read | Fixed in tree: says a person must answer in a terminal |
| C6 | `doctor` unknown, no hint | run | Fixed in tree: hint to `purix hooks doctor` (see U3 for a real top-level `doctor`) |
| C7 | An agent could read the stored key (cat of the master-key file, keyring lookup) | read | Fixed in tree for shell text and file tools; **limits in X2** |
| C8 | A (the key-store zip) failed the repo's own single-point guard (core wrote to stderr; `.purix` text in comments) | run | Fixed in tree: notice sink. No baseline raised. |

### 2.2 Messages

| ID | Problem | Status |
|---|---|---|
| G1 | `purix check` said "changed outside Purix" for a deleted file, with no next step, repeated per file, used the word "component" | Fixed in tree |
| G2 | `purix modify` and related commands claimed an edit when files were missing from disk | Fixed in tree |
| G3 | Messages should name the user's own files but hide Purix internals | Rule adopted (you corrected my first version) |

### 2.3 Test setup and test-run findings

| ID | Problem | Status |
|---|---|---|
| T1 | The opencode run's Phase 5 "drift" failures came from two deleted `security_gate` files in the test folder, not from Purix | Open: `git restore packages/core/src/gates/` before the next run |
| T2 | That run stopped at Phase 3 of 13; Phases 4 to 13 are untested | Open |
| T3 | The agent concluded "Purix is not CLI-friendly"; most of it was the approval prompt working as designed (see M1, M2: the design is right, the way it is shown is not) | Open, see section 4 |
| T4 | The test script mentions top-level `list`, `show`, `find`; they exist only under `migration`, `lang`, `tool`, `provider` | Decision: add them, or fix the script |
| T5 | `cli` test `mcp_stdout_purity` fails unless `dist/cli.js` exists | Cause found (missing build). Make the test build first, or skip with a clear reason. Open. |
| T6 | The two `SECURITY.md` copies differ at line 53 (also in packages.zip) | Open, left alone |

### 2.4 MCP (section 4 has the detail)

| ID | Problem | Status |
|---|---|---|
| M1 | Only one channel can ask a question (elicitation), and only if the client declared it. Otherwise nobody is asked and the agent gets text | Open |
| M2 | The text names only the terminal route and the server instructions say "Do not try to work around a refusal", so an agent stops and does not tell the person | Open |
| M3 | The question shown is jargon: `MCP Agent "unidentified-agent" requests full codebase re-index. Approve?` No consequence, the client name is ignored | Open |
| M4 | The form is a checkbox; pressing Accept without ticking counts as a refusal | Open (decision: the checkbox is also a safeguard, see 4.4) |
| M5 | Calling the tool again while the request is pending uses up the 20-attempt budget; call 21 says "Restart the server to continue" | Open |
| M6 | Some refusals are not questions and give no route: "TrustGate aborted ... Rephrase the instruction and try again" | Open |
| M7 | A pending approval is returned as a normal result (`isError` false) with no structured status, so a client or model cannot tell "waiting" from "done" | Open |
| M8 | `purix approve` is hidden from help, has no `--watch`, and nothing alerts the person that a request is waiting | Open |
| M9 | Timeouts are silent: the question gives up after 5 minutes and the pending request expires after 30; both read as a plain refusal / "expired" with no "ask again" step | Open |

### 2.5 Usability (section 5)

| ID | Problem | Status |
|---|---|---|
| U1 | A newcomer does not know the order: connect, then create, then approve | Open |
| U2 | Errors do not always give what happened, why, and the exact next command | Partly fixed (check, no-input, drift); not audited elsewhere |
| U3 | No top-level `doctor` | Open |
| U4 | `purix approve` is the one command every MCP user must find, and it is hidden | Open (same as M8) |
| U5 | Many commands need a terminal; PowerShell users hit quoting and path issues | Open |

### 2.6 Limits that remain (not bugs in the change, but real)

| ID | Limit |
|---|---|
| X1 | The real OS keyring was never exercised (tests use a fake; no D-Bus here). Everything ran on Node 22, not your Node 26.5. |
| X2 | A keyring does not stop another program running as you, an agent included. The hook rules are a text check, not a wall: a path built at run time or a script run later is missed. Claude Code's built-in `Read` tool is not in the registered hook matcher. |
| X3 | Walk-up widens one thing: an old per-folder store in any folder above where you run Purix can supply a key. The notice names the file used. |
| X4 | A standalone MCP server process (not through `purix mcp-serve`) queues credential notices silently |
| X5 | The user-test script's new Phase 14 is untested |

---

## 3. What the MCP part does today (run, not guessed)

I started the real server (`purix mcp-serve`, built from the merged tree) from a test client over stdio and called a gated tool (`purix_index` with `full: true`) in three client modes. The probe is `mcp-approval-probe.mjs` (usage in the file header).

| Client mode | What happened |
|---|---|
| Declares no elicitation (`none`) | Nobody was asked. Result: text only, `isError` false: "Full indexing needs a person's approval. Nothing was changed. Request <id> is waiting ... A person must run `purix approve <id>` in a terminal; it cannot be approved through MCP." |
| Declares elicitation, person ticks the box (`accept`) | A question was shown, the action ran |
| Declares elicitation, person declines (`decline`) | The action was refused with "you declined" |
| Same gated call 25 times while pending (`none`, repeat 25) | Calls 1 to 20 returned "waiting". Call 21: `Rejected: this MCP session has reached its limit of 20 gated-action attempts (PURIX_MCP_MAX_GATED_ACTIONS). Restart the server to continue.` |

Quoted from the code (read):
- Server instructions: "You cannot approve it yourself. Do not try to work around a refusal."
- The question text: `MCP Agent "unidentified-agent" requests full codebase re-index. Approve?`; the form has one boolean `approve`, `default: false`, "Tick to approve this action. Leave unticked to refuse it."; accept without the box ticked maps to "decline"; a thrown error maps to "error", treated as a refusal.
- `ELICIT_TIMEOUT_MS = 5 * 60 * 1000`; `APPROVAL_TTL_MS = 30 * 60 * 1000`.

**What I did not reproduce:** your actual hosts (Claude Code, opencode). I do not know which of the three modes each one was in when it "got stuck". The code and the three-mode run explain the behaviour; they do not prove which mode your session was in. To find out, run the probe's `none` mode and compare with what the host shows, or check whether the host declares elicitation.

### Why it feels stuck (each point tied to evidence above)

1. In `none` mode there is no question at all (M1). The only route is a terminal command the agent can read but the person may never see.
2. The agent is told not to work around it (M2) and is not told to relay it. The natural behaviour is to stop quietly or retry.
3. Retrying burns the budget (M5) and ends in "Restart the server", which is a second dead end.
4. The result is not an error and not a success (M7), so hosts that treat a tool call as done/failed have no category for "waiting for a person".

The design underneath (fail closed, only a person can approve, an agent cannot approve itself) is correct and matches the research below. The problem is what the agent and the person are told, and how often.

---

## 4. Best solution for MCP: keep fail-closed, make it a guided pause

### 4.1 Principle

An approval that needs a person is not an error and not a refusal. It is a **pause with an owner**: Purix says who must act, what they will see, what exactly to do, and what the agent should do meanwhile. No change below lets an agent approve anything.

### 4.2 Changes (ordered by value for effort)

| # | Change | Fixes | Size | Risk to governance |
|---|---|---|---|---|
| 1 | Rewrite the pending text and server instructions so they address the agent: "Tell the person, in plain words, what you were about to do and that they must approve it. Then wait. Do not call this tool again until they say they approved it." Keep "you cannot approve it yourself". | M2 | S | None |
| 2 | Add `structuredContent` to the result: `{ status: "awaiting_human_approval", requestId, expiresAt, approveCommand, actionSummary }`, and an `outputSchema` for it. Keep the human text. | M7 | S | None |
| 3 | Make a repeat call for the same pending request return the same request id and **not** count against the cap; count only new requests. When the cap is hit, say in plain words what to do (ask the person to restart the agent session, or raise `PURIX_MCP_MAX_GATED_ACTIONS`). | M5 | S | Low: the cap still limits new requests |
| 4 | Question text in user terms with the client name from the MCP handshake: `Claude Code wants to rebuild the whole project index. This reads every file and may take a few minutes. Nothing is deleted.` One line of consequence per gated tool. | M3 | M | None |
| 5 | `purix approve --watch`: waits, prints each new request in plain words, asks y/N, and rings the terminal bell. Make `purix approve` visible in `--help` (it is the one hidden command every MCP user needs). | M8, U4 | M | None: still a person at a terminal |
| 6 | Best-effort desktop notification "A request is waiting for you: purix approve" (notify only, no approve button). | M8 | M | None as long as it never approves |
| 7 | Refusals that are not questions (M6): say whose move it is: "Purix will not do this; rephrase the instruction" for a policy block versus "waiting for a person" for an approval. Drop the generic "Rephrase" where rephrasing cannot help. | M6 | S | None |
| 8 | When a request expires or the question times out, say so and how to ask again: "The request expired. Call the tool again to create a new request." | M9 | S | None |

Changes 1, 2, 3, 7, 8 are text and counting only, and can ship together first. 4, 5, 6 add behaviour.

### 4.3 What not to do

- **Do not** add auto-approve for agents, or any path where the MCP tool approves itself. `PURIX_MCP_AUTO_APPROVE=1` stays a CI-only escape hatch.
- **Do not** let a notification carry an approve action; a click is easier to automate or spoof than a typed command.
- **Do not** rely on hosts showing the elicitation question. Research (below) found few hosts display it. That is why the terminal route has to be made good, not dropped.

### 4.4 Recheck of my earlier idea "remove the checkbox"

I had planned to replace the checkbox with a bare accept/decline. On rechecking the code I would **not** do that. The box defaults to `false`, so a client that auto-accepts the form without showing it returns `approve: false` and nothing runs. With a bare accept/decline, an auto-accepting client would approve. The checkbox is a fail-closed guard against careless clients.

Better: keep the box, fix the words ("Tick the box, then press Accept, to allow this"), and when someone presses Accept without ticking, answer "You pressed Accept without ticking the box, so nothing was approved. Ask again if you meant to approve", not "declined". Decision for you: also allow one automatic re-ask in that case, or not.

### 4.5 Future, not now

- **URL-mode elicitation** (spec feature): send the person to a local page to approve. Needs a local web page and a token; larger scope. Client support unknown.
- **Tasks extension (SEP-2663, `input_required`)**: the spec's direction for "the server needs input mid-task". It would give a clean "waiting for a person" state. Client support is unknown, and the repo's SDK is 1.32.1. Design change 2 so it can be mapped onto tasks later.

### 4.6 Client support, as far as I found (research, not tested)

| Host | Elicitation |
|---|---|
| Claude Code | Interactive terminal sessions only |
| Cursor, VS Code / Copilot | Documented |
| Codex, Gemini CLI, OpenCode, Windsurf, Antigravity | Not confirmed |
| Zed | Not supported |

This table changes quickly; check each host's current docs before telling users.

### 4.7 Tests to add with these changes

- Pending result carries `structuredContent.status` and the same id on a repeat call; repeat does not consume the cap; the 21st **new** request does.
- Question text contains the client name and no "unidentified-agent" when the client identified itself.
- Accept without the tick yields the "nothing was approved" message, not "declined".
- `purix approve --watch` against a seeded pending request (a TTY-less test can feed stdin).
- The probe's four scenarios as an automated test: it spawns the real server, so it covers the stdio path too.

---

## 5. Usability: recheck of my earlier suggestions

Checked against the code. Several of my first suggestions overlap with things that already exist.

| Earlier suggestion | What the code already does | Verdict | Better way |
|---|---|---|---|
| New `purix start` wizard | `cli.ts` deliberately answers `start`, `init`, `setup`, `new` with: "There is no "start" step: Purix sets itself up the first time you run a command", and points to `create`, `connect`, `tools`. The help page ends with a "First steps" block. | **Do not add a new command.** It contradicts a deliberate decision and adds a 40th thing to learn. | Make `purix connect` the one guided path: after it succeeds, print the next two steps and, in a terminal, offer to run `purix create` with an example prompt. |
| Command trimming | Already done: one help page, grouped, most used first, operator commands unlisted (`cli.front_door.test.ts`). | **Mostly done.** | Only unhide `approve` (M8). Do not trim more without usage data. |
| Top-level `doctor` | Only `hooks doctor` exists; `doctor` gets a hint. | **Feasible, small, worth it.** | One `purix doctor` that runs: Node version, agent connected, hook installed, key found (and where from), pending approvals waiting, build/dist present. Every line ends with the exact fix command. Reuse `hooks doctor` and `secret status` code. |
| `purix explain <error or word>` | Nothing | **Feasible but build last.** | Cheaper first step: make every error say what happened, why, and the next command (U2); an `explain` command would only repeat those texts. Do it as a lookup of the same message catalogue. |
| `purix tour` | Nothing | **Low value now.** | A docs page with the three-step path and screenshots serves beginners better and costs less. |
| `approve --watch` and desktop notice | Not present | **Feasible, high value** | Section 4.2 items 5 and 6 |
| Plain-language errors everywhere | Done for check, no-input, drift, modify | **Needs an audit, not a rewrite** | Grep the error strings; fix those without a next step. Add a test that fails on a new error string without a "next step" field once the catalogue exists. |
| PowerShell friendliness | Not audited | **Unknown; test it** | Run the user-test script on Windows PowerShell once. Quoting of `purix create "..."`, paths with spaces and the approve command are the likely trouble. |

Net recommendation for beginners, in order: (1) the MCP guided pause, because it is where beginners get stuck; (2) top-level `doctor`; (3) `connect` ends with next steps; (4) `approve` visible plus `--watch`; (5) error audit; (6) a one-page "first ten minutes" doc. `start`, `tour` and `explain` can wait.

---

## 6. Decisions for you

1. Should `purix migration accept-drift` be person-only like `secret set`? `purix check` now tells people to run it "yourself in a terminal"; the code asks for a confirmation, but I did not read that path closely.
2. Add top-level `list`, `show`, `find`, or fix the test script (T4)?
3. Keep the checkbox in the approval question (my advice: yes, with better words) (4.4)?
4. Should a pending approval stay `isError: false` (my advice, with structured status), or be marked as an error so that more hosts stop and report it? An error may trigger retry loops in some models.
5. Does the walk-up search for old stores (X3) stay, or only the exact folder as before?
6. Approve the order in section 1 and the MCP changes 1, 2, 3, 7, 8 as the first batch? I will show the full diff before running anything.

## 7. Not verified

- Real OS keyring on any platform (X1).
- Your actual MCP hosts' behaviour (section 3, "What I did not reproduce").
- Host elicitation support (section 4.6) is from documentation and reports, not from running each host.
- The MCP and usability changes in sections 4 and 5 are **proposals; no code for them has been written or changed in the tree.**

## 8. Reproducing the MCP findings

From the repo root, after `pnpm install` and `pnpm build`:

```
node mcp-approval-probe.mjs packages/cli/dist/cli.js none        # no elicitation: pending text only
node mcp-approval-probe.mjs packages/cli/dist/cli.js accept       # person approves
node mcp-approval-probe.mjs packages/cli/dist/cli.js decline      # person declines
node mcp-approval-probe.mjs packages/cli/dist/cli.js none 25      # watch the 20-attempt budget run out
```

The probe uses a throwaway project and user folder.

## Sources (research)

- MCP specification, elicitation (form and url modes; accept / decline / cancel) and the 2026-07-28 revision (error -32021 for a missing capability).
- MCP tasks extension SEP-2663 (`input_required`, `inputRequests`, `tasks/update`).
- arXiv 2611.02527 (fail-closed approval for agent tools; few hosts render elicitation).
- Host documentation for Claude Code, Cursor and VS Code on elicitation; LangChain's human-in-the-loop interrupt pattern as the fallback comparison.

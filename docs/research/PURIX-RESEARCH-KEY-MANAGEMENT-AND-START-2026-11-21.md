# Purix: key management and `purix start` — findings and decisions

Rewritten 2026-11-21 (replaces the first version of the same date). Code pin: `c8a0031e-packages.zip`, sha-256 38a70a1d71c3c66b (first 16 hex). Evidence labels: **Code** (read in the uploaded tree), **Docs** (vendor or spec page read on 2026-11-21), **Judgment** (my reasoning, not measured). Each decision says what it rests on.

## 0. What was and was not run

- The first version of this note was from reading only. For this rewrite I read more code (provider persistence, confirm/stdin handling, hook rules, connect). Nothing was executed for the research findings.
- Build and test results for `purix start` are in the build report at the end of the session, not in this note. They are Linux-only (Node 22.23.5 container), with stubbed provider calls; no real model call, no Windows, no macOS, no real OS keyring.
- Not researched here: `purix doctor`, plain-words rewrite of help text, tour, real-user tests.

## 1. Findings that drive the decisions

**F1. Two credentials (Code, Docs).** The agent's own login is not Purix's. Purix's own model key is. Anthropic's terms bar routing requests through Free/Pro/Max credentials or collecting Claude.ai logins ([legal page](https://code.claude.com/docs/en/legal-and-compliance)). Claude Code has no MCP sampling (issue #1785 open); only 7 clients in the `mcp-client-capabilities` list declare it. So Purix needs its own key; there is no workable borrowed-model route today.

**F2. Environment variables do not reliably reach Purix's MCP server (Docs, SDK source read locally).** The MCP stdio client passes `HOME, LOGNAME, PATH, SHELL, TERM, USER` (Windows: `APPDATA, USERPROFILE, ...`) plus the config `env` block. `connectAgent` writes only `PURIX_MCP_AGENT_ID`. A key found through `HOME` (user store) reaches the server; a shell variable may not. Not tested against any real agent.

**F3. Comparable tools keep one credential location per user, keyring first, file fallback, env var override (Docs).** Claude Code, Codex (`auto`/`file`/`keyring`/`ephemeral`), GitHub CLI, OpenCode. None keeps a per-folder store.

**F4. The provider choice is per project today (Code, new in this rewrite).** `persistProviderChoice` writes `<cwd>/.purix/provider-config.json`; `activeProviderId()` reads only the environment variable `PURIX_LLM_PROVIDER` and that project file. The key is user-level, but the choice of provider is not. A person who set up Purix in one folder gets "No LLM provider is configured" in another, and `mcp-serve` (whose working folder the agent picks) can miss it entirely. This is the original per-folder problem again, one level up. The first version of this note missed it.

**F5. Typing a key into the agent is excluded (Docs, Code).** The MCP elicitation spec says servers MUST NOT request API keys through form mode; URL mode is the sanctioned route and is optional for clients. Purix's own hooks already mark `secret set|rotate|remove|migrate` human-only.

**F6. Prompting plumbing (Code).** `confirm()`/`promptLine()` share one process-wide line reader that stays attached to stdin; `readSecretValue` puts stdin in raw mode and reads it directly. Used together, the line reader also receives the pasted key and queues it as an "answer" to the next question. `start` mixes both, so this has to be handled (see D9).

**F7. Nothing checks a key before the first real call (Code).** `provider status` says so itself.

## 2. Decisions

**D1. Keep the user-level credential store. `start` fills it; it is not removed.** Rests on F1, F2, F3. (Judgment on weighing; the facts are Docs/Code.)

**D2. `start` collects Purix's model key only. The agent step needs no key.** F1.

**D3. The provider choice also becomes user-level.** New file `<user folder>/provider-default.json`, registry providers only. Order of lookup in `activeProviderId()`: environment `PURIX_LLM_PROVIDER` → the project's `provider-config.json` → the user default. A project can still choose its own registry provider; a project's `custom` endpoint stays behind the existing trust gate and `custom` is not offered by `start` (still `purix provider set custom`). F4. The user default is read from the user's own folder, which a cloned repository cannot write, so it adds no new trust gap.

**D4. When the key is already in the environment, `start` says so, and offers to also save a copy to the user store.** Reason: F2 (the MCP server may not see the shell variable). This revises my first note, which said not to copy. The concern about conflicts is covered: the guard only blocks a *different* value, and the environment still wins. Default answer: yes; the question says why.

**D5. `start` runs only with a person at a terminal (stdin and stdout both TTY) and is added to the hooks' human-only list.** Otherwise it prints the two manual commands and exits non-zero. F5.

**D6. One tiny live call checks the key, after a yes/no question that says what is sent and to whom.** A failed call does not delete the stored key; it prints the provider's sanitized error and the next step, and exits non-zero. A declined check exits zero and says the key is unchecked. F7.

**D7. The agent step runs `purix connect` (same detection, same hook offer), after asking.** It is run as a child process of the same CLI so it keeps its own options and tests. Answering no skips it. Judgment, because `connect` is a large inline command; wrapping it avoids a risky refactor.

**D8. `start` does not index the project.** The key and provider are per user; indexing is per project and takes time. It ends by printing the next steps. Judgment.

**D9. Hidden key input runs with the shared line reader detached from the pasted text** (a small helper in `cli-io/confirm.ts`: anything the reader queued while the hidden read ran is discarded). F6.

**D10. Re-running `start` shows current state first and changes nothing unless asked.** Replacing a stored key uses the existing rotate rules. Judgment.

**D11. The old per-folder store: still read, never written by `start`; if it holds the chosen provider's key, `start` points to `purix secret migrate`. Remove it after one release of notice.** F3 shows no comparable tool has one. Cost and timing are a decision for you; I did not measure how many keys exist in that form.

**D12. Error messages point to `purix start` first.** The "No LLM provider is configured" and "API key isn't available" messages gain one line naming `purix start`; their existing wording stays (tests and agents rely on it).

## 3. Deferred, with reasons

- **Agent-facing setup status** (a read-only MCP tool or a block in `purix_status` that tells the person to run `purix start` in a terminal). Decided yes in principle (F5); not built in this pass to keep the change reviewable.
- **`purix doctor`, hiding the `secret` group in help.** Judgment: do after `start` is used.
- **URL-mode key page.** Optional spec feature; client support unchecked.
- **P1, Linux keyring read inside the MCP server (Code reading only).** `get()` reads the keyring whenever the index says `keyring`; only `set()`/`describe()` check for a desktop session, and `DBUS_SESSION_BUS_ADDRESS` is not in the MCP default environment. Needs a test on a Linux desktop with a real Secret Service. Undecided until then.
- **P2 macOS Keychain prompts, P3 real Windows Credential Manager run.** Unresearched / untested.

## Sources

- Claude Code authentication: https://code.claude.com/docs/en/authentication.md
- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- Codex authentication: https://learn.chatgpt.com/docs/auth
- GitHub CLI `gh auth login`: https://cli.github.com/manual/gh_auth_login
- OpenCode providers: https://opencode.ai/docs/cli/providers/
- MCP client capabilities list: https://cdn.jsdelivr.net/npm/mcp-client-capabilities@0.0.14/README.md
- Claude Code MCP sampling issue: https://github.com/anthropics/claude-code/issues/1785
- MCP elicitation spec (2026-07-28): https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation
- MCP env variables in GUI clients (third party): https://mcpplaygroundonline.com/blog/mcp-server-env-variables-not-working.md
- MCP TypeScript SDK `client/stdio.js` (`@modelcontextprotocol/sdk@1.17.0`, read locally)
- Netwrix on AI coding assistant credential storage: https://netwrix.com/pt/resources/blog/ai-coding-assistant-credential-storage-risks/

# Environment variables Purix reads

This is the one list. `pnpm run env-docs-check` fails when the code reads a variable that is not written here in backticks. It checks that a name is listed, not that the description is right: the descriptions below come from reading the code that reads each variable and were not run against a real agent, Windows or macOS.

Core reads its variables only through `packages/core/src/platform/env.ts` (three functions, so the kind of read is visible at the call site). The cli and mcp-server packages read a few directly; those are in the last table.

## Defined by Purix (`purixEnv`)

| Variable | Read in | What it does |
|---|---|---|
| `PURIX_API_URL` | `security/api_client.ts` | Address of the Purix service; a default address is used when it is not set. |
| `PURIX_COST_CEILING_USD` | `llm/budget.ts` | The spend ceiling for model calls. |
| `PURIX_DEP_LOOKUP` | `security/dep_lookup.ts` | Off until you turn it on. When set, it decides on its own (a value that turns it off wins over the stored answer). When unset, the answer stored by `purix lookup on|off` (asked once at the end of `purix connect`, in a terminal only) decides, except in CI, where only this variable counts. `osv`, `registry`, `all` (or `1`) turns on the lookup of dependencies a change adds: names and exact versions go to api.osv.dev and/or the package registry. See `docs/DECISIONS-2026-11-12.md`. |
| `PURIX_DEV_TIER` | `licensing/tier.ts` | Overrides the licence tier. For development and tests. |
| `PURIX_DUPLICATION_CHECK` | `verify/duplication.ts` | Off by default. Set to `1` to count, for each verified change, the lines of the changed files that sit in a repeating block of six or more lines elsewhere in the project, before and after. Runs on this machine, no network, information only. |
| `PURIX_HEAL_EARLY_STOP` | `recovery/heal_config.ts` | Settings for when the repair loop stops early. |
| `PURIX_INTERNAL_LANGUAGES` | `language/registry.ts` | When it is `true`, the registry starts with the internal language providers. |
| `PURIX_LLM_PROVIDER` | `llm/providers.ts` | Chooses the model provider. |
| `PURIX_LLM_TIMEOUT_MS` | `platform/net.ts` | Time limit for a model request, in milliseconds. |
| `PURIX_RESULT_LINE` | `observe/result_line.ts` | Set to `off` to stop Purix adding its one-line summary (checks, stops, spend, budget left) to MCP replies. On by default. |
| `PURIX_SANDBOX_ENV_PASS` | `sandbox/sandbox_env.ts` | Names of extra variables to pass into the sandbox. The sandbox otherwise filters the environment. |
| `PURIX_SCHEDULER_POLL_MS` | `state/scheduler.ts` | How often the scheduler polls, in milliseconds (30,000 by default). |
| `PURIX_SECRET_BACKEND` | `security/user_secrets.ts` | Where `purix secret set` keeps a key: `auto` (default: the OS keyring when it works, otherwise an encrypted file in your user folder), `file` (never touch the keyring; use this on a server or in CI with no desktop session) or `keyring` (never fall back to a file; fail instead). In `auto` mode the real keyring is also skipped when `NODE_ENV=test`, when `CI` is set, or when `PURIX_USER_DIR` is set. |
| `PURIX_STRICT_ISOLATION` | `sandbox/sandbox_env.ts` | Strict isolation switch; read as a trimmed, lower-cased text value. |
| `PURIX_USER_DIR` | `usage/consent.ts` and others | Where Purix keeps its per-user folder; defaults to the folder under the home directory. |
| `PURIX_WEBHOOK_SECRET` | `cli-io/notify.ts` | Secret for the notification webhook; a secret stored with `purix secret set PURIX_WEBHOOK_SECRET` is used when it is not set. |
| `PURIX_WEBHOOK_URL` | `cli-io/notify.ts` | Address of the notification webhook. |

## Defined by the platform, only read (`ambientEnv`)

| Variable | What Purix does with it |
|---|---|
| `AUTO_CONFIRM` | With `NODE_ENV=test`, answers confirmation prompts automatically (`cli-io/confirm.ts`). Ignored outside tests. |
| `CI` | Read as the usual continuous-integration marker. |
| `DO_NOT_TRACK` | Read as the usual opt-out marker. |
| `HOME` | The home directory, where it is used to find the user folder and agent settings. |
| `NODE_ENV` | `test` changes some prompts (see `AUTO_CONFIRM`). |

## Names that come from data

Some names cannot be listed because the data owns them: each model provider's key variable, per-model overrides, and brand-prefixed overrides, all read through `dataDrivenEnv` in `platform/env.ts`. Look at `llm/providers.ts` for the provider names.

## Read directly in the cli and mcp-server packages

| Variable | Read in | What it does |
|---|---|---|
| `PURIX_MCP_AUTO_APPROVE` | `mcp-server/src/server.ts` | `1` means nobody is asked to approve a gated action in this MCP session. Meant only for CI. |
| `PURIX_MCP_READ_ALLOW` | `mcp-server/src/server.ts` | Extra directories an agent-supplied read path may point into, split on the operating system's path separator. |
| `PURIX_MCP_MAX_GATED_ACTIONS` | `mcp-server/src/server.ts` | Limit on gated-action attempts in one MCP session. |
| `PURIX_MCP_AGENT_ID` | `cli/src/cli/commands/connect_agent.ts` | The agent's name in the audit trail. Written into the MCP server entry that `purix connect` creates. |
| `PURIX_YES` | `cli/src/cli/commands/index.ts` | `1` pre-answers one command's advisory prompt, like `--yes`. It never affects diff approval on create, modify or change. |
| `PURIX_QUIET` | `cli/src/cli/output.ts` | `1` turns on quiet output. |
| `PURIX_HOOK_PAYLOAD_LOG` | `cli/src/cli/commands/hook.ts` | A file path. When set, hook calls and answers are appended to it, as evidence for real-agent runs. Off by default. |
| `PURIX_DEBUG_TIMING` | `cli/src/cli.ts` | `1` prints start-up timing. |

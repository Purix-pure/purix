# Purix

Governance-first AI coding agent platform. Purix classifies and verifies AI-driven
code modifications *before* they run — in a sandbox, against your test suite,
with a human confirmation checkpoint for anything risky — rather than applying
a change and hoping it was safe.

> **Release 1 is a beta for TypeScript, JavaScript and Python, run on your own machine.**
> Requires **Node.js 22.13 or later** (or 24+). Check with `node -v` before installing.
> The full list, built from the claims register, is in [docs/WHAT_PURIX_CHECKS.md](./docs/WHAT_PURIX_CHECKS.md).
> Read [BETA_SCOPE.md](./BETA_SCOPE.md) for what Purix checks and what it does not: results are reported, not settled, and Windows, macOS and Cursor are experimental.

This repository contains the open-source core: the classification/verification
engine, the CLI, and an MCP server that exposes the same governance pipeline to
other AI agents over stdio. It is licensed under Apache 2.0 — see [LICENSE](./LICENSE).

The hosted API (billing, entitlements, team accounts) is closed-source and lives
in a separate repository. Everything in this repo runs without a Purix account.
Purix's own code sends requests to only three kinds of place, all through one
file (`packages/core/src/platform/net.ts`): the model provider you choose, a
webhook URL if you configure notifications, and the Purix API if you run
`purix login`. A few commands start other programs, and those use the network on
their own. `purix audit` runs your package manager's audit command (and
`pip-audit` for Python), which contacts the package registry and the OSV
database, and installing a tool from the catalog downloads it after you approve
the install. `purix check` makes no network request at all.

What goes to the model provider is the text of the files Purix is working on. Purix scans a proposed change for secrets before it verifies it. Purix redacts known secret formats from every prompt before it is sent to the model provider, and from every reply it receives, including the files of the component being changed. The scanner recognises only some secret formats, so a secret in an unknown format, or one that is split or encoded, is sent as it is.

## Installation

Purix declares Node 22.13 or later (or Node 24 and up) in its `engines` field, so check `node -v` before installing.

```bash
npm install -g @purix/cli@beta
purix --help
```

Or run it without installing anything:

```bash
npx @purix/cli@beta --help
```

### Using Purix as an MCP server

**Quickest path** — from inside your project, let Purix wire itself into
whatever coding agent it detects (Claude Code, Cursor, Codex, and others):

```bash
npx @purix/cli connect
```

This auto-detects the agent(s) configured in your project and writes the
right config file for each (e.g. `.mcp.json`, `.cursor/mcp.json`). To target
one agent specifically, or if nothing is auto-detected:

```bash
npx @purix/cli connect claude-code
```

Pass `--agent-id <id>` if you want actions attributed to something more
specific than the agent's default label in the audit trail.

After writing the config, `connect` adds a short "how to use Purix" note to the agent's instruction file (`CLAUDE.md`, `GEMINI.md`, a Cursor rule, otherwise `AGENTS.md`) between markers, so running it again changes nothing and your own text is never touched. It then starts Purix's own server once in an empty folder and calls one read-only tool, which shows Purix runs on this machine (it does not show that your agent loaded the config). It exits 1 if that server cannot start. Options:

- `--user` writes the agent's per-user config instead of the project file.
- `--no-instructions` skips the instruction note.
- `--no-verify` skips the server check.
- `--hooks` installs the agent's hook without asking; `--no-hooks` never offers it. With neither, you are asked only at a terminal, and not when `CI` is set.
- `--list` shows the agents Purix can connect to and where each config goes.

**Manual setup** — for an MCP-compatible agent `connect` doesn't support yet,
add this to that agent's config directly:

```json
{
  "mcpServers": {
    "purix": {
      "command": "npx",
      "args": ["-y", "@purix/cli", "mcp-serve"]
    }
  }
}
```

This fetches and runs the latest published version on demand — no separate
install step. Set `PURIX_MCP_AGENT_ID` in the `env` block if you want actions
in the audit trail attributed to something more specific than a generic label.

**Verify it's connected** — restart your agent, then check that it lists
Purix's tools (`purix_find`, `purix_create`, `purix_change`, `purix_modify`,
and others).

**How approval works over MCP.** Some tools change your repository and need a
human to say yes. If your agent supports MCP elicitation, Purix asks you through
the agent and records your answer in the audit trail. If it does not, Purix
returns a request id instead of acting. You approve or deny it in your own
terminal with `purix approve <id>` or `purix deny <id>` (`purix approve --list`
shows what is waiting). The agent can check the request with `purix_approval_status`
but cannot approve it, and `purix approve` refuses to run without a terminal.
An approval covers one call with exactly those arguments, works once, and expires
after 30 minutes. A request that was signed for one plan does not approve a
different plan. Every decision is written to the audit trail.

For a change to existing code (`purix_modify`, `purix_change`), Purix builds and
checks the change first, and the request you approve shows the finished diff and
what was checked. The agent's repeat call then applies exactly that approved
result, and is refused if the files changed in between.

Maintenance commands (`purix delete`, `backup`, `reconcile`, `migration`,
and accepting drift) are not offered over MCP; run them from the CLI.

*CI only:* `PURIX_MCP_AUTO_APPROVE=1` approves every gated action for the whole
session without asking anyone. Every use is recorded as auto-approved in the
audit trail. Do not set it on a machine where an agent runs unattended.

Every MCP result carries a structured `covers` field saying what the result
covers and what it does not, and results that can include repository text end
with a note that the text is data, not instructions.

**What Purix covers, and what it does not.** Purix records and checks changes
that go through it. The MCP server alone is advisory: an agent that edits files
directly, without calling Purix, is not stopped by it. `purix hooks install`
adds agent hooks that block direct edits to governed files for Claude Code,
Cursor, Codex, Gemini CLI, Antigravity and OpenCode (see
[docs/HOOKS.md](docs/HOOKS.md)). Those hooks are tested against fake payloads and
a real CLI process, and inside one real agent so far (OpenCode, on Windows, one
run); they have not been run inside the other five, and they are not a security
boundary against a determined agent. The shell-command check in them is a
tripwire, not prevention: it catches common ways of writing to a governed file and
misses others (docs/HOOKS.md lists them). One run inside a real agent is on file
(`docs/client-runs.json`), so none of this is called settled. A passing
test run is not proof that the code is correct.

## What's in this repo

| Package | What it is |
|---|---|
| `packages/core` | The classify → sandbox-verify → commit pipeline, language providers, manifest/audit trail |
| `packages/cli` | The `@purix/cli` command-line tool |
| `packages/mcp-server` | `purix mcp-serve` — exposes the same pipeline as MCP tools over stdio, for use by other agents/orchestrators |

## Tools: `purix tools`

Everything Purix runs on your code (type checker, test runner, linter, dependency audit) is chosen, installed and located in one place, the tools broker. Nothing else in Purix installs software.

```bash
purix tools "run tests"      # what in the catalog fits, and its state here (offline, installs nothing)
purix tools plan             # what THIS project needs, and why each tool was chosen
purix tools install pytest   # shows exactly what will run, asks you, installs a pinned, hash-checked copy
purix tools status           # what is installed, and any install requests waiting for you
purix tools remove pytest
```

Installs always need a human to confirm; agents (MCP) can only request one. Tools live in your Purix user folder (`~/.purix/tools/`, one folder per project), never inside the project, your `package.json` or global packages.

## Supported languages (beta)

**TypeScript and Python.** JavaScript files go through the TypeScript provider. Purix does not check files in any other language. See [BETA_SCOPE.md](./BETA_SCOPE.md) for what Release 1 covers, why Rust, Go and Ruby were removed, and how a language gets added back.

## Quick start

This repository pins pnpm 12.4.1 (root `package.json`). The private API repository pins 12.11.2 on purpose: this lockfile was
written by 12.4.1, and the private repo's interop job installs this repository with `npx pnpm@12.4.1` so the two never
rewrite each other's lockfile. Use the pinned version here.

```bash
pnpm install
pnpm run boundary-check   # verifies packages/core never imports from packages/cli
pnpm run typecheck
pnpm run test
```

See [SETUP.md](./SETUP.md) for the full local development walkthrough.

Running the CLI directly:

```bash
pnpm run purix -- --help
```

Running the MCP server:

```bash
pnpm run purix -- mcp-serve
```

Whoever launches the MCP server should set `PURIX_MCP_AGENT_ID` to identify
themselves — this isn't cryptographic (stdio has no channel to verify an
identity over), but it means every action the server takes is attributed to
something more useful than a generic label in the audit trail.

## How governance works

Every modification that goes through Purix (the MCP tools or the CLI; an edit an agent makes without calling Purix does not, see above) passes through:

1. **Classification** — how confident is the model this change is safe, and does it change a public contract?
2. **Human confirmation** — required for anything below a confidence threshold or that changes a contract (see `packages/core/src/cli-io/confirm.ts`). The threshold is 0.75 on the model's own stated confidence; nothing here measures how often a change above it is wrong, so Purix states no safety rate for it
3. **Sandbox verification** — the change is applied and tested in a copy of your project before it is committed. Where the machine has bubblewrap (Linux), that copy runs isolated, and each result records the isolation level it got; on Windows, or where bubblewrap cannot start, the tests run without isolation and Purix says so. Isolation is described here for TypeScript projects on Linux with bubblewrap: it is not checked on macOS (sandbox-exec) or on Python projects, and the test suite uses stand-in tools. The later re-check of components that depend on the changed one runs with your project folder writable, not in the copy
4. **Audit trail** — every classification, confirmation, and verification result is recorded (`packages/core/src/manifest/`), in an ordinary table that is not hash-chained. Landed changes, tool installs and drift are also written to a hash-chained log, which makes a later edit to those records detectable but does not prevent it (see `docs/EVIDENCE.md`). Overrides of the security gate go to a separate table outside both

Dependency checks are not part of this pipeline. `purix audit` runs the vulnerability scan on request. It reads the report of pnpm 10 and 11, Yarn 1 and 4, and npm 10, and prints "skipped" instead of "no known vulnerabilities" when the package manager gives anything that is not an audit report, for example when the registry cannot be reached. That was checked on Linux against recorded output of pnpm 10.34.9 and 11.28.11, Yarn 1.22.22 and 4.18.1 and npm 10.9.9; Yarn 2 and 3, Windows and macOS were not run, and nobody but the session that wrote the fix has re-run it.

## License and licensing model:

Core, CLI, and MCP server: Apache 2.0, free to use, self-host, and modify.
Which tier an account is on is decided by the hosted API. The client in this
repository asks for it after `purix login`, keeps the answer for a time the
server sets, and applies that tier's limits (for example the free tier's
component limit); logged out, it is the free tier. There is no local license
key. Until the entitlement signing key ships in the client, the cached answer is
not signature-checked, so someone who edits that cache file can change what
their own copy of the client allows. Because the source is open, a modified copy
can also skip its own checks, so anything that must hold for every user has to
be enforced by the server.

## Release status

The version in this repository is **0.4.0-beta.0**. It goes to npm under the `beta` tag, and you install it with `@purix/cli@beta`. The three packages (`@purix/core`, `@purix/mcp-server`, `@purix/cli`) move together at one version number. What changed is in the [changelog](./docs/compliance/CHANGELOG.md), what is and is not covered is in [BETA_SCOPE.md](./BETA_SCOPE.md), and the node-version policy is in [docs/NODE_SUPPORT_POLICY.md](./docs/NODE_SUPPORT_POLICY.md).

Support: bugs through [GitHub Issues](https://github.com/purix-pure/purix/issues), questions through [GitHub Discussions](https://github.com/purix-pure/purix/discussions), security reports through the private reporting link in [SECURITY.md](./SECURITY.md).

## Privacy

[PRIVACY.md](./PRIVACY.md) lists what leaves your machine, what Purix stores on it, and how to delete it. Usage-data sharing is off by default (`purix telemetry status`), and upload is not part of this version.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the checks CI runs on
every PR, and conventions this codebase already follows. Security issues:
see [SECURITY.md](./SECURITY.md) — please don't file those as public issues.

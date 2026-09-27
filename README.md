# Purix

Governance-first AI coding agent platform. Purix classifies and verifies AI-driven
code modifications *before* they run — in a sandbox, against your test suite,
with a human confirmation checkpoint for anything risky — rather than applying
a change and hoping it was safe.

This repository contains the open-source core: the classification/verification
engine, the CLI, and an MCP server that exposes the same governance pipeline to
other AI agents over stdio. It is licensed under Apache 2.0 — see [LICENSE](./LICENSE).

The hosted API (billing, entitlements, team accounts) is closed-source and lives
in a separate repository. Everything in this repo runs fully standalone with no
account or network dependency required.

## Installation

```bash
npm install -g @purix/cli
purix --help
```

Or run it without installing anything:

```bash
npx @purix/cli --help
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
and others). Any action requiring confirmation will show up in your agent as
a normal tool call awaiting approval — nothing runs unreviewed.

## What's in this repo

| Package | What it is |
|---|---|
| `packages/core` | The classify → sandbox-verify → commit pipeline, language providers, manifest/audit trail |
| `packages/cli` | The `@purix/cli` command-line tool |
| `packages/mcp-server` | `purix mcp-serve` — exposes the same pipeline as MCP tools over stdio, for use by other agents/orchestrators |

## Supported languages (beta)

**TypeScript and Python.** See [BETA_SCOPE.md](./BETA_SCOPE.md) for why, and how a
language gets added back.

## Quick start

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

Every modification a Purix-connected agent proposes goes through:

1. **Classification** — how confident is the model this change is safe, and does it change a public contract?
2. **Human confirmation** — required for anything below a confidence threshold or that changes a contract (see `packages/core/src/cli-io/confirm.ts`)
3. **Sandbox verification** — the change is actually applied and tested in an isolated environment before it's ever committed
4. **Audit trail** — every classification, confirmation, and verification result is recorded (`packages/core/src/manifest/`)

## License and licensing model:

Core, CLI, and MCP server: Apache 2.0, free to use, self-host, and modify.
Paid tiers (team accounts, additional entitlements) are enforced entirely
server-side by the hosted API — never by anything in this repository. That's a
deliberate architectural choice: gating a feature by hiding code from you
would defeat the point of publishing the source.

## Contributing

See [CONTRIBUTING.md](./docs/compliance/CONTRIBUTING.md) for setup, the checks CI runs on
every PR, and conventions this codebase already follows. Security issues:
see [SECURITY.md](./docs/compliance/SECURITY.md) — please don't file those as public issues.

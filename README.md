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
npm install -g purix
purix --help
```

Or run it without installing anything:

```bash
npx purix --help
```

### Using Purix as an MCP server

Add this to your MCP client's config (Claude Code, Claude Desktop, Cursor, or
any other MCP-compatible agent):

```json
{
  "mcpServers": {
    "purix": {
      "command": "npx",
      "args": ["-y", "purix", "mcp-serve"]
    }
  }
}
```

This fetches and runs the latest published version on demand — no separate
install step. Set `PURIX_MCP_AGENT_ID` in the `env` block if you want actions
in the audit trail attributed to something more specific than a generic label.

## What's in this repo

| Package | What it is |
|---|---|
| `packages/core` | The classify → sandbox-verify → commit pipeline, language providers, manifest/audit trail |
| `packages/cli` | The `purix` command-line tool |
| `packages/mcp-server` | `purix mcp-serve` — exposes the same pipeline as MCP tools over stdio, for use by other agents/orchestrators |

## Supported languages (beta)

**TypeScript and Python.** See [BETA_SCOPE.md](./BETA_SCOPE.md) for why, and how a
language gets added back.

## Quick start

```bash
npm install
npm run boundary-check   # verifies packages/core never imports from packages/cli
npm run typecheck
npm run test
```

See [SETUP.md](./SETUP.md) for the full local development walkthrough.

Running the CLI directly:

```bash
npm run purix -- --help
```

Running the MCP server:

```bash
npm run purix -- mcp-serve
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

## License and licensing model

Core, CLI, and MCP server: Apache 2.0, free to use, self-host, and modify.
Paid tiers (team accounts, additional entitlements) are enforced entirely
server-side by the hosted API — never by anything in this repository. That's a
deliberate architectural choice: gating a feature by hiding code from you
would defeat the point of publishing the source.

## Contributing

See [CONTRIBUTING.md](./docs/compliance/CONTRIBUTING.md) for setup, the checks CI runs on
every PR, and conventions this codebase already follows. Security issues:
see [SECURITY.md](./docs/compliance/SECURITY.md) — please don't file those as public issues.

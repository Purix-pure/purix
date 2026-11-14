# @purix/cli

The command-line tool for **Purix**, a governance layer for AI-driven code changes. Purix classifies a change, verifies it in a sandbox against your test suite, asks a human to confirm anything risky, and records what it did. It also runs as an MCP server (`purix mcp-serve`) so other coding agents can use the same pipeline.

> **This is a beta (`0.4.0-beta.1`) for TypeScript, JavaScript and Python, run on your own machine.**
> Requires **Node.js 22.13 or later** (or 24+). Results are reported, not settled. Windows, macOS and Cursor are experimental. Read [BETA_SCOPE.md](https://github.com/purix-pure/purix/blob/main/BETA_SCOPE.md) for what Purix checks and what it does not.

## Install

```bash
npm install -g @purix/cli@beta
purix --help
```

Use the `beta` tag to get the newest beta. Without a tag, npm installs whatever the `latest` tag points at, which can be an older beta.

Or run it without installing:

```bash
npx @purix/cli@beta --help
```

## Connect a coding agent

From inside your project:

```bash
npx @purix/cli connect
```

This detects the agents configured in the project and writes the MCP config for each. Run `purix connect --list` to see the supported agents.

## Privacy and security

- Everything runs on your machine without a Purix account. Purix's own code sends requests to only three kinds of place: the model provider you choose, a webhook you configure, and the Purix API if you run `purix login`. `purix check` makes no network request.
- Usage data sharing is **off by default**, and upload is not part of this version.
- Read [PRIVACY.md](https://github.com/purix-pure/purix/blob/main/PRIVACY.md) for exactly what leaves your machine and what Purix stores.
- Report security issues privately: see [SECURITY.md](https://github.com/purix-pure/purix/blob/main/SECURITY.md).

## More

Full documentation, the list of what Purix checks, and the changelog are in the [repository](https://github.com/purix-pure/purix). Licensed under Apache 2.0.

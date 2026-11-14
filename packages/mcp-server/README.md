# @purix/mcp-server

The MCP server library for **Purix**: it exposes the classify, sandbox-verify and record-evidence pipeline to AI coding agents as MCP tools over stdio.

**To run Purix as an MCP server, use the CLI**, which is the supported entry point:

```bash
npx @purix/cli connect        # wires Purix into the agents it detects in your project
npx @purix/cli mcp-serve      # or start the server directly, for an agent's manual config
```

This package has no executable of its own. It is published so `@purix/cli` can depend on it.

> **Beta (`0.4.0-beta.1`).** TypeScript, JavaScript and Python only. Requires Node.js 22.13 or later (or 24+). The MCP server alone is advisory: an agent that edits files directly, without calling Purix, is not stopped by it. See [BETA_SCOPE.md](https://github.com/purix-pure/purix/blob/main/BETA_SCOPE.md).

- What leaves your machine, and what is stored: [PRIVACY.md](https://github.com/purix-pure/purix/blob/main/PRIVACY.md)
- Reporting a security issue: [SECURITY.md](https://github.com/purix-pure/purix/blob/main/SECURITY.md)
- Source and issues: https://github.com/purix-pure/purix

Licensed under Apache 2.0.

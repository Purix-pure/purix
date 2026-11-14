# @purix/core

The engine behind **Purix**: the classify, sandbox-verify and record-evidence pipeline, the language providers (TypeScript, JavaScript, Python), and the manifest and audit trail.

**You probably want [`@purix/cli`](https://www.npmjs.com/package/@purix/cli)**, which is the tool people install and run. This package is published so the CLI and the MCP server can depend on it. Its internal modules (imported as `@purix/core/<path>`) are not a stable public API during the beta and can change between `0.x` releases.

> **Beta (`0.4.0-beta.1`).** TypeScript, JavaScript and Python only. Requires Node.js 22.13 or later (or 24+). See [BETA_SCOPE.md](https://github.com/purix-pure/purix/blob/main/BETA_SCOPE.md) for what is and is not covered.

- What leaves your machine, and what is stored: [PRIVACY.md](https://github.com/purix-pure/purix/blob/main/PRIVACY.md)
- Reporting a security issue: [SECURITY.md](https://github.com/purix-pure/purix/blob/main/SECURITY.md)
- Source and issues: https://github.com/purix-pure/purix

Licensed under Apache 2.0.

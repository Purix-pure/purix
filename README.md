Supported languages (beta)
TypeScript and Python. See BETA_SCOPE.md for why, and how a language gets added back.

Quick start
pnpm install
pnpm run boundary-check   # verifies packages/core never imports from packages/cli
pnpm run typecheck
pnpm run test
See SETUP.md for the full local development walkthrough.

Running the CLI directly:

pnpm run purix -- --help
Running the MCP server:

pnpm run purix -- mcp-serve
Whoever launches the MCP server should set PURIX_MCP_AGENT_ID to identify themselves — this isn't cryptographic (stdio has no channel to verify an identity over), but it means every action the server takes is attributed to something more useful than a generic label in the audit trail.

How governance works
Every modification a Purix-connected agent proposes goes through:

Classification — how confident is the model this change is safe, and does it change a public contract?
Human confirmation — required for anything below a confidence threshold or that changes a contract (see packages/core/src/cli-io/confirm.ts)
Sandbox verification — the change is actually applied and tested in an isolated environment before it's ever committed
Audit trail — every classification, confirmation, and verification result is recorded (packages/core/src/manifest/)
License and licensing model
Core, CLI, and MCP server: Apache 2.0, free to use, self-host, and modify. Paid tiers (team accounts, additional entitlements) are enforced entirely server-side by the hosted API — never by anything in this repository. That's a deliberate architectural choice: gating a feature by hiding code from you would defeat the point of publishing the source.

Contributing
See CONTRIBUTING.md for setup, the checks CI runs on every PR, and conventions this codebase already follows. Security issues: see SECURITY.md — please don't file those as public issues.
# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security vulnerability.

Instead, use GitHub's private reporting flow: go to this repository's
**Security** tab → **Report a vulnerability**
([direct link](https://github.com/purix-pure/purix/security/advisories/new)).
This opens a private advisory visible only to maintainers until a fix is
ready, which avoids disclosing an exploitable issue before a patch exists.

Include, if you have them:
- The affected package (`@purix/core`, `@purix/mcp-server`, or `@purix/cli`) and version (`purix --version`).
- Your operating system and Node.js version.
- Steps to reproduce, or a minimal repro case.
- What you'd expect to happen vs. what actually happens.
- Whether the issue requires a specific target-project setup to trigger (Purix
  operates on arbitrary user codebases via sandboxed execution — several past
  issues in this codebase were specific to one package manager's layout or
  one platform, so that context speeds up triage a lot).
- Which coding agent was connected, if any, and whether hooks were installed.

### What to expect

Purix is a small, pre-1.0 project. Reports are read by a maintainer, who will
reply on the advisory. There is no guaranteed response time. We will tell you
whether we accept the report as a vulnerability, work with you on a fix, and
agree a disclosure date with you before anything is made public. Please do not
disclose publicly before a fix is available or a date is agreed. If you want
credit in the advisory, say so; if you want to stay anonymous, say that.

## Supported versions

Purix is pre-1.0 and in beta. Only the **latest published release** receives
security fixes; there is no backport policy yet. As of this writing that is
`0.4.0-beta.x`, published under the npm `beta` tag. Each package's `version`
in its `package.json` is the source of truth.

## Scope

This repository stores credentials at rest (`secret-set`/`secret-rotate`
commands) and runs verification of target codebases in a subprocess
(isolated with bubblewrap on Linux where it is available; the README says what
isolation covers and where it is not checked). Reports involving either of those — credential handling,
sandbox escape, or unintended write access outside the sandboxed
environment — are treated as high priority.

Also in scope: the MCP server's approval flow (an agent approving its own
request, an approval reused for a different action, a path read or write
outside what the server allows), the agent hooks (a direct edit to a governed
file that gets through when it should be blocked), and anything that makes
Purix send repository content somewhere the [privacy document](../../PRIVACY.md)
says it does not go.

The hosted API (billing, entitlements, team accounts) lives in a separate,
closed-source repository and is out of scope here; if you find an issue
there, please still use this repo's private reporting flow and we'll route
it appropriately.

## Known limitations (documented, not vulnerabilities)

These are stated limits of the current release. A report that only restates one
of them is not a new finding, but a way to make one worse than documented is.
The full list is in [BETA_SCOPE.md](../../BETA_SCOPE.md).

- **Hooks are not a security boundary.** They block common direct edits to governed files for the agents they support. The shell-command check is a tripwire, not prevention: it catches common ways of writing to a governed file and misses others (`docs/HOOKS.md` lists them). The MCP server alone is advisory.
- **Isolation is described for TypeScript projects on Linux with bubblewrap.** It is not checked on macOS or on Python projects, and where no sandbox tool exists (Windows, or a container that blocks it) verification runs unisolated and the result says so. A project's own compiler, linter or test runner is code the project chose: the sandbox contains it, it does not vet it. `PURIX_STRICT_ISOLATION=1` makes a step refuse to run without a sandbox.
- **The secrets master key sits beside the encrypted store.** Owner-only file permissions and keeping the files out of version control protect against accidents, not against someone who can read your user folder.
- **Approver identity is not cryptographic.** "Authorized approver" means a user name on a list in a file in the project's `.purix/` folder; anyone who can write that folder can change it.
- **The entitlement cache is not yet signature-checked** in the client, so someone who edits that cache can change what their own copy allows. Anything that must hold for every user is enforced by the server.
- **Secret redaction recognises only some formats.** A secret in an unknown, split or encoded form can reach the model provider.
- **`PURIX_MCP_AUTO_APPROVE=1` approves every gated action** in an MCP session without asking anyone. It is meant for CI. Do not set it where an agent runs unattended on a machine you care about.
- **`purix audit` can miss advisories** for pnpm projects; "none found" on one is not a clean bill.

## Verifying a release

Releases published from CI are built once, checksummed (`SHA256SUMS` is uploaded
with the workflow run) and published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
which ties the package to the workflow run that built it. The first beta is
published by hand and does not carry provenance; the release notes say which
releases do.

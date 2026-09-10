# Security Policy

## Reporting a vulnerability

Please do **not** open a public GitHub issue for a security vulnerability.

Instead, use GitHub's private reporting flow: go to this repository's
**Security** tab → **Report a vulnerability**. This opens a private
advisory visible only to maintainers until a fix is ready, which avoids
disclosing an exploitable issue before a patch exists.

Include, if you have them:
- The affected package (`@purix/core`, `@purix/mcp-server`, or `purix`) and version.
- Steps to reproduce, or a minimal repro case.
- What you'd expect to happen vs. what actually happens.
- Whether the issue requires a specific target-project setup to trigger (Purix
  operates on arbitrary user codebases via sandboxed execution — several past
  issues in this codebase were specific to one package manager's layout or
  one platform, so that context speeds up triage a lot).

## Scope

This repository stores credentials at rest (`secret-set`/`secret-rotate`
commands) and executes verification against target codebases in a sandboxed
subprocess. Reports involving either of those — credential handling,
sandbox escape, or unintended write access outside the sandboxed
environment — are treated as high priority.

The hosted API (billing, entitlements, team accounts) lives in a separate,
closed-source repository and is out of scope here; if you find an issue
there, please still use this repo's private reporting flow and we'll route
it appropriately.

## Supported versions

Purix is pre-1.0 (see each package's `version` in its `package.json`). Until
a 1.0 release, only the latest published version on npm receives security
fixes — there's no backport policy yet.

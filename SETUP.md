# SETUP.md — Local Development Setup

## Prerequisites
- Node.js 22.13.0+ on the 22 line, or 24+ (see `docs/NODE_SUPPORT_POLICY.md`)
- pnpm@12.4.1 (see `packageManager` in the root `package.json`; install via `corepack enable`
  or `npm install -g pnpm@12.4.1` if you don't already have it)
  This repository and the closed-source hosted API repository are separate workspaces and use different pnpm versions
  on purpose. This one pins 12.4.1. The API repository pins 12.11.2, and its interop CI job installs this repository
  with `npx pnpm@12.4.1` because this lockfile was written by the older pnpm 12. When you work here, the 12.4.1 pin is
  the one that matters. Do not align the two without a deliberate decision to.

## Quick Start
1. Install dependencies:
   ```bash
   pnpm install
   ```
2. Run boundary check:
   ```bash
   pnpm run boundary-check
   ```
3. Run type checking across all packages:
   ```bash
   pnpm run typecheck
   ```
4. Run the full test suite:
   ```bash
   pnpm run test
   ```
5. Run coverage validation for the security-relevant core paths (llm, licensing, gates, sandbox, verify; 90% lines, branches and functions):
   ```bash
   pnpm run coverage
   ```

## CLI Integration Testing Contract

The CLI integration suite in `packages/cli/src/cli.integration.test.ts` is the
command-surface safety net. It must cover every registered command, nested
subcommand, positional signature, and option in `buildProgram()`. It also runs
safe local commands and verifies lifecycle commands fail closed when state is
missing.

Keep integration runs isolated: use a temporary working directory and temporary
home/config paths, never real credentials, never a production provider, and
never approve destructive confirmations automatically. Commands that require an
LLM, network service, MCP peer, or human confirmation need a separate explicit
integration fixture and must not be silently skipped in its report.

When adding or removing a CLI command, update the command contract test and add
one behavior assertion beyond registration. Run:

```bash
pnpm --filter @purix/cli test
pnpm --filter @purix/cli typecheck
```

## Hunting a flaky test

One red run in several hundred tests says little. `scripts/repeat-run.mjs` runs a command many times and names each test that failed, with the number of runs it failed in:

```bash
node scripts/repeat-run.mjs --runs 20 --keep-going -- pnpm run test
```

The `Repeat run` workflow does the same on a weekly schedule and on demand. Logs of failed runs go to `repeat-run-logs/` (or `$REPEAT_RUN_LOGS`).

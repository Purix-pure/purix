# SETUP.md — Local Development Setup

## Prerequisites
- Node.js >= 22.13.0
- npm >= 10.0.0 (ships with Node)

## Quick Start
1. Install dependencies:
   ```bash
   npm install
   ```
2. Run boundary check:
   ```bash
   npm run boundary-check
   ```
3. Run type checking across all packages:
   ```bash
   npm run typecheck
   ```
4. Run the full test suite:
   ```bash
   npm run test
   ```
5. Run coverage validation for core LLM and licensing paths:
   ```bash
   node --import tsx --test --experimental-test-coverage --test-coverage-lines=90 --test-coverage-branches=90 --test-coverage-functions=90 "packages/core/src/{llm,licensing}/**/*.test.ts"
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
npm run test --workspace=@purix/cli
npm run typecheck --workspace=@purix/cli
```

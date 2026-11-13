# ISO/IEC 42001 — AI System Lifecycle Controls

## 1. Lifecycle Stages
- **Design & Architecture:** Architecture Decision Records (ADRs) cover TrustGate, Deterministic Override Floors and sandboxed execution. The ADRs are kept outside this repository.
- **Development & Verification:** `node scripts/purix-04-run-all.mjs` runs the gates: boundary check, typecheck, lint, build, the test suites, and a 90% coverage threshold on `packages/core/src/{llm,licensing,gates,sandbox,verify}` (`pnpm run coverage`).
- **Deployment & Operation:** CI (`.github/workflows/ci.yml`) runs those gates on Linux. The Windows and macOS jobs run with `continue-on-error`, so they do not block a release. At start-up Purix finishes or rolls back interrupted operations (`reconcilePendingOperations`), and a repository lock (`packages/core/src/state/repo_lock.ts`) is meant to keep two Purix commands from writing at once. Both have known open defects: the lock does not yet cover every command, and reconcile can run before the lock is checked.

# ISO/IEC 42001 — AI System Lifecycle Controls

## 1. Lifecycle Stages
- **Design & Architecture:** Governed by Architecture Decision Records (ADRs) covering TrustGate, Deterministic Override Floors, and sandboxed execution.
- **Development & Verification:** Controlled via `pnpm run boundary-check`, `pnpm run typecheck`, and unit tests (`pnpm run test`) with strict code coverage requirements (`pnpm run coverage`).
- **Deployment & Operation:** Enforced via CI workflows (`.github/workflows/ci.yml`), automated pre-action startup reconciliation (`reconcilePendingOperations`), and repo locking (`repo_lock.ts`).

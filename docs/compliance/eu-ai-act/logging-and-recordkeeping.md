# EU AI Act — Article 12 Logging & Record-Keeping

## 1. Logged Artifacts & Schema
Purix logs all override decisions, security gate bypasses, cost metrics, and test history through SQLite-backed storage (`packages/core/src/manifest/store.ts`, `override_audit.ts`, `test_history.ts`).
- **Override Audits Table:** Records timestamp, gate name, user rationale, and original finding details.
- **Manifest Version History:** Maintains immutable append-only version histories with provenance tracking for every component modification.

## 2. Retention & Known Gaps
- **Retention Policy:** Currently, local SQLite journals and audit tables do not implement automated log rotation/retention pruning. This is explicitly noted as an open operational gap for future enterprise hardening.

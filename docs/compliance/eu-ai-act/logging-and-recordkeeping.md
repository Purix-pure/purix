# EU AI Act — Article 12 Logging & Record-Keeping

## 1. Logged Artifacts & Schema
Purix keeps its records in a local SQLite database (`packages/core/src/manifest/store.ts`).
- **Events:** classification, confirmation and verification results go to the `events` table (`manifest/events.ts`). It is an ordinary table and is not hash-chained. It also holds the `unadopted_write` rows that name files an agent wrote that no component governs.
- **Hash-chained log:** landed changes, tool installs, drift and model-baseline changes are written to `audit_chain` (`security/audit_tamper_evidence.ts`). Each record carries the hash of the one before it, so a later edit to an earlier record is detectable. It does not stop the edit, and without an external anchor a rebuilt chain looks valid (see `docs/EVIDENCE.md`).
- **Overrides and test history:** `override_audits` and `test_history.ts` are ordinary tables, but each override decision is also written into `audit_chain` in the same transaction, so editing or deleting an `override_audits` row is detected by `purix check` (`security/override_audit.ts`, `security/override_in_chain.test.ts`).
- **Version history:** each component entry keeps a `version_history` list in the manifest. Nothing prevents someone with write access to the database file from editing it.

## 2. Retention & Known Gaps
- **Retention:** local journals and audit tables have no automated rotation or pruning. This is an open operational gap.

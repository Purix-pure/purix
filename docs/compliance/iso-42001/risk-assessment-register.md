# ISO/IEC 42001 — AI Risk Assessment Register

| Risk ID | Risk Description | Severity | Status | Mitigation / Reference |
|---|---|---|---|---|
| R-01 | Python verification hardcoded to TypeScript (false pass on non-TS files) | Critical | Mitigated for TypeScript and Python | Language registry dispatch and Python test integrity checks. Files in other languages are not checked, and the result does not yet say so in every case (`BETA_SCOPE.md`). |
| R-02 | Security gate override state module-level concurrency hazard | High | Partly mitigated | `runSecurityGate` accepts an explicit override reason and clears the module-level value after one use. The CLI still sets that module-level value through `setSecurityOverride`. |
| R-03 | Missing cryptographic identity for auth (OS username trust tradeoff) | High | Accepted | Approvers are identified by operating-system user name. The Team-tier fields `rbac` and `sharedRepoMemory` were removed from `tier.ts` on 2026-10-14, so no feature depends on a stronger identity yet. |
| R-04 | On-demand tool installation supply chain surface | Medium | Documented | Exact tool versions and file hashes pinned in the tools catalog (`packages/core/src/tools/catalog_data.ts`), shared by CI and the CLI; one install path (the tools broker) with human consent and an audit entry; `scripts/check-tool-boundary.ts` fails CI if tool installing or locating reappears outside `core/src/tools/`. |

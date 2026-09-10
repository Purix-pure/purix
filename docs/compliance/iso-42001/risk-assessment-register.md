# ISO/IEC 42001 — AI Risk Assessment Register

| Risk ID | Risk Description | Severity | Status | Mitigation / Reference |
|---|---|---|---|---|
| R-01 | Python verification hardcoded to TypeScript (false pass on non-TS files) | Critical | Mitigated | Remediated in Phase 1 & 2 via language registry dispatch and Python test integrity checks. |
| R-02 | Security gate override state module-level concurrency hazard | High | Mitigated | Remediated in Phase 4 via explicit parameter passing in `runSecurityGate`. |
| R-03 | Missing cryptographic identity for auth (OS username trust tradeoff) | High | Accepted / Guarded | Gated Team-tier `rbac` and `sharedRepoMemory` in `tier.ts` until real IDP is implemented. |
| R-04 | On-demand tool installation supply chain surface | Medium | Documented | Pinned exact tool versions (`PYTHON_PINNED_VERSIONS`) shared between CI and LanguagePack specs. |

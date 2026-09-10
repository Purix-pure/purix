# EU AI Act — Annex IV Technical Documentation

## 1. System Description & Intended Purpose
Purix is a verification and governance framework (`@purix/core`, `purix` (CLI), `@purix/api`, `@purix/mcp-server`) designed to govern AI-generated code edits. It provides cryptographic provenance, deterministic override floors, and multi-language verification sandbox execution.

## 2. Risk Controls & Thresholds
- **TrustGate Thresholds (`packages/core/src/gates/trustgate.ts`):**
  - Reject threshold: `< 0.35` (automatic abort).
  - Confirm threshold: `0.75` (auto-commit if high confidence and non-contract-changing; human confirmation required otherwise).
- **Deterministic Override Floors (DOF):** Configured via glob patterns in `dof-patterns.json` preventing automated overrides on sensitive files (`.env`, auth configuration, crypto routines).
- **Security Gate (`packages/core/src/gates/security_gate.ts`):** Scans for hardcoded secrets, SQL injection, command injection, weak cryptography, and typosquatting.

## 3. Known Limitations & Remediation History
- **Python Parity Remediation:** Prior versions hardcoded TypeScript-only verification in `verifyInSandbox`. This has been remediated by dispatching verification through `getLanguageProvider()` / `resolveLanguage()`, adding AST-based test integrity checks for Python via `python_test_integrity.ts`, and introducing three-state tool status handling (`pass`, `fail`, `not_installed`).

## 4. Language Pack On-Demand Install Model (Phase 3.5)
Language tooling (`pyright`, `pytest`, `ruff`, `pip-audit`) is installed on-demand per user via `purix lang install <id>` with explicit consent and tier gating (`pro`), preventing unnecessary base dependencies while ensuring rigorous verification.

# ISO/IEC 42001 — Data and Dependency Governance

## 1. Data Handling & Secrets Protection
- Secrets and entropy checks (`secrets.ts`, `secrets_manager.ts`) block hardcoded API keys and credentials before write operations reach the sandbox or filesystem.
- Outbound LLM calls scrub sensitive context and enforce budget ceilings (`budget_state`).

## 2. Dependency & Supply Chain Controls
- Version pinning (`checkVersionPinning`, `deps_audit.ts`).
- Vulnerability scanning (`runVulnScan`, `pip-audit`, `pnpm audit`).
- Pinned tool version parity between CI (`ci.yml`) and Language Packs (`python.pack.ts`) to prevent drift and supply-chain tampering.

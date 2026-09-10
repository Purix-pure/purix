# EU AI Act — Article 14 Human Oversight Compliance

## 1. Concrete Implementation
Human oversight is structurally enforced through:
- **TrustGate `human_confirm` Path:** Edits falling between the reject threshold (`0.35`) and confirm threshold (`0.75`), or edits marked as contract-changing, mandatory require human operator confirmation (`packages/core/src/cli-io/confirm.ts`).
- **Deterministic Override Floors (DOF):** Modifications hitting DOF glob patterns cannot be auto-committed and require explicit human review and override audit logging (`packages/core/src/security/override_audit.ts`).
- **Authorization Enforcement (`packages/core/src/security/auth.ts`):** Only authorized operators listed in `.purix/authorized_operators.json` (with owner-only permission bits `0o600`) may approve gated modifications.

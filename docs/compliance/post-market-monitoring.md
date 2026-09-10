# EU AI Act — Post-Market Monitoring Plan

## 1. Ongoing Review Procedures
- **Gate Override Rate Tracking:** Review `override_audits` periodically to detect recurring security gate bypasses or model prompt injection attempts.
- **Verification Regression Harnesses:** Run CI regression suites (`npm run test`) across golden-set fixtures for TypeScript and Python (`ADR-036`, `ADR-044`) on every commit and release.
- **Incident Reporting:** False-pass or false-negative incidents (such as the historical Python verification gap) trigger mandatory regression test additions to `sandbox.test.ts`.

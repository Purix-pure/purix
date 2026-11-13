# EU AI Act — Post-Market Monitoring Plan

## 1. Ongoing Review Procedures
- **Gate override review:** reading the overrides for repeated security-gate overrides is a manual task. `purix audit-log trail` lists them, but no job or alert does the review.
- **Regression suites:** CI runs the test suites, including golden-set fixtures for TypeScript and Python (`ADR-009`, `ADR-013`, formerly ADR-036/ADR-044), on every push and pull request.
- **Incident reporting:** a false pass or false negative (such as the earlier Python verification gap) should be followed by a regression test in `sandbox.test.ts`. This is a working rule; no check enforces it.

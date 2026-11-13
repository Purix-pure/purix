# ISO/IEC 42001 — Internal Audit Procedure

## 1. Audit Schedule & Scope
- **Quarterly reviews (intended):** re-audit the governance gates, the test-integrity checkers and the language pack specs. No review record is stored in this repository.
- **Continuous validation:** typecheck, boundary checks and test suites run in CI on every push and pull request.
- **Findings log (working rule):** a regression or security finding should be recorded in the risk register and fixed with a failing test case before merge. No check enforces this.

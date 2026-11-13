# ISO/IEC 42001 — AI Management System Scope

## 1. Scope Definition
The Artificial Intelligence Management System (AIMS) covers the code in this repository: `@purix/core`, `@purix/cli` and `@purix/mcp-server`. That includes the governance gates, the verification sandbox, the code that calls model providers, and the client side of licensing (it asks the hosted API for a tier and applies the answer; the cached answer is not signature-checked yet). The hosted API (`@purix/api`) is in a separate private repository and is outside this scope.

This document describes what the code does today. It is not a certification and does not claim conformity with ISO/IEC 42001.

## 2. Accountability & Roles
- **Lead Maintainer / Engineering Lead:** Accountable for keeping the security gates, the hash-chained log and the CI checks working.

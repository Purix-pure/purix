# EU AI Act — Risk Classification Analysis for Purix

## 1. System Definition
Purix is a verification and governance layer that works on source codebases (autonomous code-writing agents and developer workflows). It applies thresholds and path rules (TrustGate, Deterministic Override Floors, Security Gate) and verifies changes in a sandbox before they are written.

## 2. Article 3 AI System Analysis
Purix calls language models (via LLM integrations) to classify code edits and to repair failed ones. The classification confidence that TrustGate uses is reported by the model.

## 3. Risk Tier Assessment under the EU AI Act
- **Category:** General-Purpose AI (GPAI) model integrator and developer tool governance layer.
- **Risk Classification:** software engineering tools are generally not classified as high-risk AI systems under Annex III unless embedded in critical infrastructure (for example medical devices or aviation). Purix operates on client codebases that may span regulated sectors, so it includes controls (Deterministic Override Floors, TrustGate confidence scoring, human confirmation, secret scanning, sandboxed verification). These controls have not been assessed against any formal standard or compared with other tools.
- **Legal Review Note:** formal legal assessment should be conducted by enterprise adopters integrating Purix into critical domain workflows. This file is not a legal opinion.

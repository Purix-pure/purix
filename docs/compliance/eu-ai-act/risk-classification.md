# EU AI Act — Risk Classification Analysis for Purix

## 1. System Definition
Purix is an AI-driven verification and governance layer operating on source codebases (autonomous code-writing/committing agents and developer workflows). It enforces deterministic safety thresholds (TrustGate, Deterministic Override Floors, Security Gate) and sandbox verification prior to code ingestion or modification.

## 2. Article 3 AI System Analysis
Purix incorporates automated reasoning and machine learning models (via LLM integrations) to classify code edits, verify intent, and assist in developer workflows.

## 3. Risk Tier Assessment under the EU AI Act
- **Category:** General-Purpose AI (GPAI) model integrator and developer tool governance layer.
- **Risk Classification:** While software engineering tools are generally not classified as high-risk AI systems under Annex III unless embedded in critical infrastructure (e.g., medical devices, aviation), Purix operates on client codebases that may span regulated sectors. Therefore, Purix implements strict risk controls (Deterministic Override Floors, TrustGate confidence scoring, human confirmation checkpoints, secret scanning, and sandboxed write verification) that exceed standard developer tool requirements.
- **Legal Review Note:** Formal legal assessment should be conducted by enterprise adopters integrating Purix into critical domain workflows.

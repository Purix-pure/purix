// src/llm/model_baseline.ts
import { appendAuditRecord } from "../security/audit_tamper_evidence.js";

export interface ModelBaselineFixture {
  provider: string;
  model: string;
  prompt: string;
  expectedKeywords: string[];
}

export const MODEL_BASELINES: ModelBaselineFixture[] = [
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    prompt: "Return JSON fixing the bug",
    expectedKeywords: ["edits", "reasoning"],
  },
  {
    provider: "openai",
    model: "gpt-4o",
    prompt: "Return JSON fixing the bug",
    expectedKeywords: ["edits", "reasoning"],
  },
];

export interface BaselineEvaluationResult {
  ok: boolean;
  missingKeywords: string[];
  reason?: string;
}

export function evaluateModelBaseline(fixture: ModelBaselineFixture, responseText: string): BaselineEvaluationResult {
  const missingKeywords: string[] = [];
  for (const kw of fixture.expectedKeywords) {
    if (!responseText.includes(kw)) {
      missingKeywords.push(kw);
    }
  }

  const ok = missingKeywords.length === 0;
  if (!ok) {
    try {
      appendAuditRecord({
        event: "ai_monitoring_event",
        type: "model_baseline_regression",
        provider: fixture.provider,
        model: fixture.model,
        missingKeywords,
      });
    } catch {}
  }

  return {
    ok,
    missingKeywords,
    reason: ok ? undefined : `Model response missing expected keywords: ${missingKeywords.join(", ")}`,
  };
}

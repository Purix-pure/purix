// packages/core/src/llm/python_model_baseline.ts
import type { ModelBaselineFixture } from "./model_baseline.js";
import { evaluateModelBaseline } from "./model_baseline.js";

export const PYTHON_MODEL_BASELINES: ModelBaselineFixture[] = [
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    prompt: "Return JSON fixing Python syntax error",
    expectedKeywords: ["edits", "reasoning", "python"],
  },
  {
    provider: "openai",
    model: "gpt-4o",
    prompt: "Return JSON fixing Python syntax error",
    expectedKeywords: ["edits", "reasoning", "python"],
  },
];

export { evaluateModelBaseline };

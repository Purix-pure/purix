// packages/core/src/platform/env.ts
//
// PURIX-21 D11(d) / PURIX-17 R4: the one place core reads environment variables. Before this, 19
// call sites read `process.env` directly, so "which variables does Purix honour" could only be
// answered by searching the tree. Now the answer is the two tuples below.
//
// Three kinds of read, each a separate function so the kind is visible at the call site:
//   purixEnv(name)       a variable Purix defines; `name` must be in PURIX_ENV (checked by the compiler)
//   ambientEnv(name)     a variable the platform defines and Purix only reads (NODE_ENV, HOME, AUTO_CONFIRM)
//   dataDrivenEnv(name)  a name taken from data: a provider's key variable, a per-model override, a
//                        BRAND_ override. These cannot be listed here because the data owns the names
// All three read `process.env` at call time (tests change it between calls). `envSnapshot()` returns the
// live environment for the two callers that must iterate it (sandbox filtering, context config).
export const PURIX_ENV = [
  "PURIX_API_URL",
  "PURIX_COST_CEILING_USD",
  "PURIX_DEP_LOOKUP",
  "PURIX_DEV_TIER",
  "PURIX_HEAL_EARLY_STOP",
  "PURIX_INTERNAL_LANGUAGES",
  "PURIX_LLM_PROVIDER",
  "PURIX_LLM_TIMEOUT_MS",
  "PURIX_SANDBOX_ENV_PASS",
  "PURIX_SCHEDULER_POLL_MS",
  "PURIX_STRICT_ISOLATION",
  "PURIX_USER_DIR",
  "PURIX_WEBHOOK_SECRET",
  "PURIX_WEBHOOK_URL",
] as const;
export type PurixEnvName = (typeof PURIX_ENV)[number];

export const AMBIENT_ENV = ["AUTO_CONFIRM", "CI", "DO_NOT_TRACK", "HOME", "NODE_ENV"] as const;
export type AmbientEnvName = (typeof AMBIENT_ENV)[number];

export function purixEnv(name: PurixEnvName): string | undefined {
  return process.env[name];
}

export function ambientEnv(name: AmbientEnvName): string | undefined {
  return process.env[name];
}

export function dataDrivenEnv(name: string): string | undefined {
  return process.env[name];
}

export function envSnapshot(): NodeJS.ProcessEnv {
  return process.env;
}

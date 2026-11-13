// packages/cli/src/load_env.ts
//
// Loads the project's .env into the environment, minus the variables that control how Purix behaves.
//
// Periodic security check, 2026-10-15 (poc2): `import "dotenv/config"` copied every line of ./.env into the
// environment. A repository someone else wrote could ship a .env containing NODE_ENV=test and AUTO_CONFIRM=1, and
// every human-approval checkpoint would then answer "yes" on its own (isAutoConfirmActive() in core). The same door
// reached PURIX_DEV_TIER (paid tiers), PURIX_API_URL and PURIX_WEBHOOK_URL (where licence checks and events go),
// proxy and certificate settings, and NODE_OPTIONS.
//
// A project .env is for API keys, so those still load. Names that steer the runtime, the platform, the network or
// Purix's own switches are ignored here and must come from the shell or the user's own configuration. A variable that
// is already set in the environment is never replaced (the same rule dotenv follows).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

const BLOCKED_NAMES = new Set([
  "NODE_ENV", "AUTO_CONFIRM", "CI", "DO_NOT_TRACK",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "PATH", "PATHEXT", "SHELL", "COMSPEC", "TMPDIR", "TEMP", "TMP", "PWD", "OLDPWD",
  "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_REPL_HISTORY",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "GLOBAL_AGENT_HTTP_PROXY",
  "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_DIR", "GIT_CONFIG_GLOBAL",
]);
const BLOCKED_PREFIXES = ["LD_", "DYLD_", "PURIX_", "NPM_CONFIG_", "PNPM_", "YARN_", "BUN_", "DENO_", "PYTHON", "PIP_", "RUBY", "GEM_", "BUNDLE_"];
/** The one PURIX_ family a project .env may set: a model name for a provider (PURIX_OPENAI_MODEL_LOW). It only picks a model id. */
const ALLOWED_PURIX = /^PURIX_[A-Z0-9]+_MODEL_(?:LOW|HIGH)$/;

export function isProjectEnvNameAllowed(name: string): boolean {
  const upper = name.toUpperCase();
  if (ALLOWED_PURIX.test(name)) return true;
  if (BLOCKED_NAMES.has(upper)) return false;
  return !BLOCKED_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export interface ProjectEnvResult {
  applied: string[];
  ignored: string[];
}

/** Applies `parsed` to `env`, skipping blocked names and names already set. Pure over its arguments, so it can be tested without touching the real environment. */
export function applyProjectEnv(parsed: Record<string, string>, env: Record<string, string | undefined>): ProjectEnvResult {
  const result: ProjectEnvResult = { applied: [], ignored: [] };
  for (const [name, value] of Object.entries(parsed)) {
    if (!isProjectEnvNameAllowed(name)) {
      result.ignored.push(name);
      continue;
    }
    if (env[name] !== undefined) continue;
    env[name] = value;
    result.applied.push(name);
  }
  return result;
}

/** Reads <dir>/.env if there is one and applies it. Never throws: a missing or unreadable file means nothing is loaded. */
export function loadProjectEnv(dir: string, env: Record<string, string | undefined>): ProjectEnvResult {
  const path = resolve(dir, ".env");
  try {
    if (!existsSync(path)) return { applied: [], ignored: [] };
    return applyProjectEnv(parse(readFileSync(path)), env);
  } catch {
    return { applied: [], ignored: [] };
  }
}

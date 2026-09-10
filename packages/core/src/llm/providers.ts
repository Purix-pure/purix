// src/llm/providers.ts
//
// BYOK (Bring Your Own Key) provider abstraction — registry-driven, not
// one-hand-written-adapter-per-vendor.
//
// The previous version of this file had a separate function per provider
// (geminiProvider, openaiProvider, anthropicProvider). That doesn't scale:
// there are hundreds of LLM endpoints in active use (US, Chinese, and
// otherwise), and writing a new function for each one would mean Purix's
// provider support forever lags behind the market by however long it takes
// someone to notice a request and ship a PR.
//
// The fix rests on one fact: nearly every LLM vendor today — OpenAI,
// DeepSeek, Qwen/Alibaba, Moonshot/Kimi, Zhipu/GLM, 01.AI, Mistral, Groq,
// Together, Fireworks, xAI, OpenRouter (itself a gateway to hundreds more
// models behind one endpoint) — exposes an OpenAI-compatible
// `/chat/completions` endpoint. Only Gemini and Anthropic have genuinely
// different wire formats, so those two keep native adapters; everything
// else is ONE generic function (`openAiCompatibleAdapter`) parameterized
// by base URL, key env var, and model ids. Adding a new provider is a
// registry entry (data), not a new file (code). A fully "custom" entry
// covers anything not yet in the registry — someone can point Purix at
// literally any OpenAI-compatible endpoint with their own key today.
//
// Design constraints carried over from the original version, unchanged:
//   - every call still goes through assertBudgetAvailable/assertCircuitClosed
//   - usage is still normalized to {inputTokens, outputTokens} for budget.ts
//   - retry/backoff semantics (4 attempts, exponential) are preserved
//   - "fail closed, never guess" — an unknown/misconfigured provider throws
//     with an actionable message, it never silently falls back to Gemini.

import { getSecret } from "../security/secrets_manager.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type ModelTier = "low" | "high";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderResult {
  text: string;
  usage: ProviderUsage;
}

export interface LlmProvider {
  id: string;
  modelFor(tier: ModelTier): string;
  generate(prompt: string, tier: ModelTier): Promise<ProviderResult>;
  isTransientError(err: unknown): boolean;
}

interface PriceTable {
  low: { input: number; output: number };
  high: { input: number; output: number };
}

// Fallback guardrail pricing for any registry entry that doesn't specify
// its own — deliberately mid-range/conservative. This is NOT billing-
// accurate for any specific vendor; it only exists so
// PURIX_COST_CEILING_USD means roughly the same thing across providers.
// Check the vendor's real pricing page for anything that matters.
const DEFAULT_PRICE: PriceTable = {
  low: { input: 0.20, output: 0.60 },
  high: { input: 1.50, output: 6.00 },
};

type ProviderKind = "gemini" | "anthropic" | "openai_compat";

interface ProviderDefinition {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Required for openai_compat; ignored for gemini/anthropic (native SDKs/endpoints). */
  baseUrl?: string;
  keyEnvVar: string;
  models: { low: string; high: string };
  price?: PriceTable;
}

// ---------------------------------------------------------------------------
// The registry. This is the part meant to grow to "hundreds" over time —
// as data, not code. Model ids drift faster than this file will be
// reviewed, so each entry's models are overridable via
// PURIX_<ID>_MODEL_LOW / PURIX_<ID>_MODEL_HIGH without touching this file.
// ---------------------------------------------------------------------------
const REGISTRY: ProviderDefinition[] = [
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "gemini",
    keyEnvVar: "GEMINI_API_KEY",
    models: { low: "gemini-3.5-flash-lite", high: "gemini-3.6-flash" },
    price: { low: { input: 0.10, output: 0.40 }, high: { input: 1.25, output: 5.00 } },
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    kind: "anthropic",
    keyEnvVar: "ANTHROPIC_API_KEY",
    models: { low: "claude-haiku-4-5-20251001", high: "claude-sonnet-5" },
    price: { low: { input: 0.80, output: 4.00 }, high: { input: 3.00, output: 15.00 } },
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai_compat",
    baseUrl: "https://api.openai.com/v1",
    keyEnvVar: "OPENAI_API_KEY",
    models: { low: "gpt-4.1-mini", high: "gpt-4.1" },
    price: { low: { input: 0.15, output: 0.60 }, high: { input: 2.50, output: 10.00 } },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai_compat",
    baseUrl: "https://api.deepseek.com/v1",
    keyEnvVar: "DEEPSEEK_API_KEY",
    models: { low: "deepseek-chat", high: "deepseek-reasoner" },
    price: { low: { input: 0.07, output: 0.28 }, high: { input: 0.14, output: 0.55 } },
  },
  {
    id: "qwen",
    label: "Alibaba Qwen (DashScope compatible mode)",
    kind: "openai_compat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyEnvVar: "QWEN_API_KEY",
    models: { low: "qwen-turbo", high: "qwen-max" },
  },
  {
    id: "moonshot",
    label: "Moonshot AI (Kimi)",
    kind: "openai_compat",
    baseUrl: "https://api.moonshot.cn/v1",
    keyEnvVar: "MOONSHOT_API_KEY",
    models: { low: "moonshot-v1-8k", high: "moonshot-v1-128k" },
  },
  {
    id: "zhipu",
    label: "Zhipu AI (GLM)",
    kind: "openai_compat",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyEnvVar: "ZHIPU_API_KEY",
    models: { low: "glm-4-flash", high: "glm-4-plus" },
  },
  {
    id: "yi",
    label: "01.AI (Yi)",
    kind: "openai_compat",
    baseUrl: "https://api.01.ai/v1",
    keyEnvVar: "YI_API_KEY",
    models: { low: "yi-lightning", high: "yi-large" },
  },
  {
    id: "mistral",
    label: "Mistral AI",
    kind: "openai_compat",
    baseUrl: "https://api.mistral.ai/v1",
    keyEnvVar: "MISTRAL_API_KEY",
    models: { low: "mistral-small-latest", high: "mistral-large-latest" },
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai_compat",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnvVar: "GROQ_API_KEY",
    models: { low: "llama-3.1-8b-instant", high: "llama-3.3-70b-versatile" },
  },
  {
    id: "together",
    label: "Together AI",
    kind: "openai_compat",
    baseUrl: "https://api.together.xyz/v1",
    keyEnvVar: "TOGETHER_API_KEY",
    models: { low: "meta-llama/Llama-3.1-8B-Instruct-Turbo", high: "meta-llama/Llama-3.1-70B-Instruct-Turbo" },
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    kind: "openai_compat",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    keyEnvVar: "FIREWORKS_API_KEY",
    models: {
      low: "accounts/fireworks/models/llama-v3p1-8b-instruct",
      high: "accounts/fireworks/models/llama-v3p1-70b-instruct",
    },
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    kind: "openai_compat",
    baseUrl: "https://api.x.ai/v1",
    keyEnvVar: "XAI_API_KEY",
    models: { low: "grok-code-fast-1", high: "grok-4" },
  },
  {
    id: "openrouter",
    label: "OpenRouter (gateway to 100s of models across vendors)",
    kind: "openai_compat",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnvVar: "OPENROUTER_API_KEY",
    // OpenRouter's own model catalogue is itself huge; these are just
    // sane defaults, fully overridable via env vars below.
    models: { low: "meta-llama/llama-3.1-8b-instruct", high: "anthropic/claude-sonnet-4.5" },
  },
  {
    id: "perplexity",
    label: "Perplexity",
    kind: "openai_compat",
    baseUrl: "https://api.perplexity.ai",
    keyEnvVar: "PERPLEXITY_API_KEY",
    models: { low: "sonar", high: "sonar-pro" },
  },
];

const REGISTRY_BY_ID = new Map(REGISTRY.map((d) => [d.id, d]));

export type ProviderId = string; // any REGISTRY id, or "custom"

function resolveKey(envVarName: string, providerLabel: string): string {
  const key = getSecret(envVarName) ?? process.env[envVarName];
  if (!key) {
    throw new Error(
      `${envVarName} isn't available. Purix does not ship or bill against a shared key — ` +
        `bring your own for ${providerLabel}. Run "purix secret-set ${envVarName} <value>" (stored ` +
        `encrypted locally, never leaves the machine except in the request to ${providerLabel} itself), ` +
        `or set it in a local .env for quick dev (never commit it).`
    );
  }
  return key;
}

function genericTransientCheck(status: number | undefined, message: string): boolean {
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  if (/quota/i.test(message)) return true;
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(message)) return true;
  return false;
}

function modelOverride(def: ProviderDefinition, tier: ModelTier): string {
  const envKey = `PURIX_${def.id.toUpperCase()}_MODEL_${tier.toUpperCase()}`;
  return process.env[envKey] ?? def.models[tier];
}

// ---------------------------------------------------------------------------
// THE generic adapter. This one function is what makes "hundreds of
// providers" tractable — every openai_compat registry entry (currently 12
// of the 15 above, and effectively unlimited via "custom") is served by
// this single implementation, parameterized by data.
// ---------------------------------------------------------------------------
function openAiCompatibleAdapter(def: ProviderDefinition): LlmProvider {
  if (!def.baseUrl) {
    throw new Error(`Provider "${def.id}" is missing a baseUrl — cannot use the generic OpenAI-compatible adapter.`);
  }
  return {
    id: def.id,
    modelFor: (tier) => modelOverride(def, tier),
    isTransientError: (err: any) => genericTransientCheck(err?.status, String(err?.message ?? "")),
    async generate(prompt, tier) {
      const key = resolveKey(def.keyEnvVar, def.label);
      const model = modelOverride(def, tier);
      const res = await fetch(`${def.baseUrl!.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err: any = new Error(`${def.label} ${res.status}: ${body.slice(0, 500)}`);
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as any;
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Native Gemini adapter (different wire format — Google's own SDK).
// ---------------------------------------------------------------------------
function geminiAdapter(def: ProviderDefinition): LlmProvider {
  let client: any = null;
  async function getClient() {
    if (client) return client;
    const { GoogleGenAI } = await import("@google/genai");
    client = new GoogleGenAI({ apiKey: resolveKey(def.keyEnvVar, def.label) });
    return client;
  }
  return {
    id: def.id,
    modelFor: (tier) => modelOverride(def, tier),
    isTransientError: (err: any) => genericTransientCheck(err?.status, String(err?.message ?? "")),
    async generate(prompt, tier) {
      const ai = await getClient();
      const model = modelOverride(def, tier);
      const result = await ai.models.generateContent({ model, contents: prompt });
      return {
        text: result.text ?? "",
        usage: {
          inputTokens: result.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: result.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Native Anthropic adapter (Messages API — different shape from chat/completions).
// ---------------------------------------------------------------------------
function anthropicAdapter(def: ProviderDefinition): LlmProvider {
  return {
    id: def.id,
    modelFor: (tier) => modelOverride(def, tier),
    isTransientError: (err: any) => genericTransientCheck(err?.status, String(err?.message ?? "")),
    async generate(prompt, tier) {
      const key = resolveKey(def.keyEnvVar, def.label);
      const model = modelOverride(def, tier);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err: any = new Error(`Anthropic ${res.status}: ${body.slice(0, 500)}`);
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as any;
      const text = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      return {
        text,
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}

function buildAdapter(def: ProviderDefinition): LlmProvider {
  switch (def.kind) {
    case "gemini":
      return geminiAdapter(def);
    case "anthropic":
      return anthropicAdapter(def);
    case "openai_compat":
      return openAiCompatibleAdapter(def);
  }
}

export function priceFor(providerId: string, tier: ModelTier) {
  const def = REGISTRY_BY_ID.get(providerId);
  return def?.price?.[tier] ?? DEFAULT_PRICE[tier];
}

// ---------------------------------------------------------------------------
// Persisted provider choice, including a fully custom (unregistered)
// endpoint. This is the "write a single generic function and let people
// point it at whatever" escape hatch: `purix provider-set custom` with
// --base-url/--key-env/--model-low/--model-high covers vendor #101 (and
// #102, #103...) without ever touching this file again.
// ---------------------------------------------------------------------------
interface PersistedProviderConfig {
  provider: string;
  custom?: { baseUrl: string; keyEnvVar: string; modelLow: string; modelHigh: string; label?: string };
}

function configPath(): string {
  return join(process.cwd(), ".purix", "provider-config.json");
}

function readPersistedConfig(): PersistedProviderConfig | null {
  try {
    const p = configPath();
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Part 2 (hot reload): mtimeMs of provider-config.json at the moment it was
// last read, or null if the file doesn't exist. Used below to detect a
// change made by ANOTHER process (e.g. `purix provider-set custom ...` run
// in a different terminal, or a long-lived process like the MCP server
// picking up a change without restarting) so getProvider()'s cache can be
// invalidated on the next call instead of serving a stale adapter forever.
function configMtimeMs(): number | null {
  try {
    return statSync(configPath()).mtimeMs;
  } catch {
    return null;
  }
}

export function activeProviderId(): string {
  const fromEnv = process.env.PURIX_LLM_PROVIDER;
  if (fromEnv) return fromEnv;
  const config = readPersistedConfig();
  if (!config) {
    throw new Error(
      `No LLM provider is configured. Run "purix provider-list" to see the registry, ` +
      `and "purix provider-set <id>" to configure one.`
    );
  }
  return config.provider;
}

let _active: LlmProvider | null = null;
let _activeId: string | null = null;
// Only meaningful when _activeId === "custom" — see the hot-reload note
// below. null means "no persisted config file existed at last build".
let _customConfigMtimeAtBuild: number | null = null;

/**
 * Part 2 (hot reload) bug fix: this cache used to key ONLY on the provider
 * id ("custom", "openai", ...). For every REGISTRY-backed provider that's
 * actually fine, because per-tier model overrides are read live from
 * process.env inside modelFor()/generate() on every call (see
 * modelOverride() above) — nothing about a registry provider's *config* is
 * baked into the cached adapter.
 *
 * "custom" is different: its baseUrl/keyEnvVar/models come from
 * provider-config.json's `custom` block, read ONCE by buildAdapter() and
 * closed over inside the adapter's generate() function. A long-lived
 * process (the MCP server, or any future daemon/scheduler) that calls
 * getProvider("custom") once and then again later would keep returning
 * that first snapshot forever — even after a separate `purix provider-set
 * custom --base-url ...` invocation (a different OS process) rewrote the
 * file out from under it — because `_activeId === wanted` short-circuited
 * before ever looking at the file's contents again.
 *
 * Fix: for "custom" specifically, also compare the config file's mtime
 * against the mtime recorded when the cached adapter was built. A changed
 * mtime invalidates the cache and rebuilds from the fresh file, same
 * poll-on-use pattern licensing/tier.ts already uses for entitlements.
 * (persistCustomProvider() below still eagerly clears the cache too, for
 * same-process same-invocation correctness — this covers the cross-
 * process case that eager clearing on write can't reach.)
 */
export function getProvider(id?: string): LlmProvider {
  const wanted = id ?? activeProviderId();

  if (_active && _activeId === wanted) {
    if (wanted !== "custom" || configMtimeMs() === _customConfigMtimeAtBuild) {
      return _active;
    }
    // Custom config changed on disk since we cached — fall through and rebuild.
  }

  if (wanted === "custom") {
    const cfg = readPersistedConfig();
    if (!cfg?.custom) {
      throw new Error(
        `No custom provider is configured. Run: purix provider-set custom --base-url <url> ` +
          `--key-env <ENV_VAR_NAME> --model-low <id> --model-high <id>`
      );
    }
    const def: ProviderDefinition = {
      id: "custom",
      label: cfg.custom.label ?? "Custom OpenAI-compatible endpoint",
      kind: "openai_compat",
      baseUrl: cfg.custom.baseUrl,
      keyEnvVar: cfg.custom.keyEnvVar,
      models: { low: cfg.custom.modelLow, high: cfg.custom.modelHigh },
    };
    _active = buildAdapter(def);
    _activeId = wanted;
    _customConfigMtimeAtBuild = configMtimeMs();
    return _active;
  }

  const def = REGISTRY_BY_ID.get(wanted);
  if (!def) {
    throw new Error(
      `Unknown LLM provider "${wanted}". Run "purix provider-list" to see the registry, or ` +
        `"purix provider-set custom ..." to point at any OpenAI-compatible endpoint not yet in it.`
    );
  }
  _active = buildAdapter(def);
  _activeId = wanted;
  _customConfigMtimeAtBuild = null;
  return _active;
}

export function persistProviderChoice(id: string): void {
  if (id !== "custom" && !REGISTRY_BY_ID.has(id)) {
    throw new Error(`Unknown provider "${id}". Run "purix provider-list" to see supported ids.`);
  }
  const dir = join(process.cwd(), ".purix");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existing = readPersistedConfig();
  writeFileSync(configPath(), JSON.stringify({ ...existing, provider: id }, null, 2));
  _active = null;
  _activeId = null;
  _customConfigMtimeAtBuild = null;
}

export function persistCustomProvider(cfg: {
  baseUrl: string;
  keyEnvVar: string;
  modelLow: string;
  modelHigh: string;
  label?: string;
}): void {
  const dir = join(process.cwd(), ".purix");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ provider: "custom", custom: cfg }, null, 2));
  _active = null;
  _activeId = null;
  _customConfigMtimeAtBuild = null;
}

export function listProviders(): { id: string; label: string; keyEnvVar: string }[] {
  return [
    ...REGISTRY.map((d) => ({ id: d.id, label: d.label, keyEnvVar: d.keyEnvVar })),
    {
      id: "custom",
      label: "Any OpenAI-compatible endpoint (bring your own base URL + key)",
      keyEnvVar: "(configured via provider-set custom)",
    },
  ];
}
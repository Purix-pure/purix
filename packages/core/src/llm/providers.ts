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

import { dataDrivenEnv, purixEnv } from "../platform/env.js";
import { netFetch } from "../platform/net.js";
import { asArray, asObject } from "../platform/json_shape.js";
import { getSecret } from "../security/secrets_manager.js";
import { sanitizeErrorText } from "../security/error_text.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { quarantineCorruptFile, readJsonFile, writeJsonAtomic } from "../platform/atomic_write.js";
import { join } from "node:path";
import { purixDir } from "../platform/layout.js";
import { createHash } from "node:crypto";
import { userStateDir } from "../usage/consent.js";

/**
 * H3: the first 500 characters of a provider's error body, with key fragments, known tokens and machine paths removed.
 * The clean-up runs BEFORE the cut to 500: cutting first could slice a key in half so the pattern no longer matches it. The
 * 20,000-character pre-cut only bounds the work on a very large body.
 */
function providerErrorBody(body: string): string {
  return sanitizeErrorText(body.slice(0, 20_000), { maxChars: 500 });
}

export type ModelTier = "low" | "high";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Input tokens the provider served from its prompt cache, when it reports them (AI-05). Measurement only: Purix sends no cache
   * markers, so this shows how often a provider's automatic caching already hits. Absent means the provider did not say, which is
   * not the same as zero. Anthropic reports it separately from `inputTokens`; OpenAI-compatible and Gemini count it inside.
   */
  cachedInputTokens?: number;
}

/** `{ cachedInputTokens }` when the provider reported a number, nothing when it did not, so absent stays distinct from zero. */
function cachedField(value: unknown): { cachedInputTokens?: number } {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? { cachedInputTokens: value } : {};
}

// H1: a provider's reply is data from outside, so nothing below assumes its shape. Each reader returns an empty value for a wrong type
// (the same thing a missing field already gave), never throws, and never lets a non-number reach the usage figures.
/** A token count: a finite number of at least 0, else 0 (a string, an object or a negative number must not reach the cost figures). */
function tokenCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
/** Text from a message body that is a string or, for some OpenAI-compatible servers, a list of `{ type: "text", text }` parts. Anything else: "". */
function textOfContent(v: unknown): string {
  if (typeof v === "string") return v;
  return asArray(v)
    .map((part) => {
      const o = asObject(part);
      return typeof o.text === "string" && (o.type === undefined || o.type === "text") ? o.text : "";
    })
    .join("");
}
/** An HTTP failure carrying the status the retry logic reads. */
function httpError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
function transientCheck(err: unknown): boolean {
  const o = asObject(err);
  return genericTransientCheck(typeof o.status === "number" ? o.status : undefined, typeof o.message === "string" ? o.message : "");
}

export interface ProviderResult {
  text: string;
  usage: ProviderUsage;
}

export interface LlmProvider {
  id: string;
  modelFor(tier: ModelTier): string;
  /**
   * `system` is optional. When given it is sent through the provider's own
   * system/instruction channel (OpenAI-style "system" message, Anthropic's
   * top-level `system`, Gemini's `systemInstruction`) — the channel providers
   * rank above user-turn text, which is where untrusted repository content
   * goes. When omitted the request is exactly what it always was.
   */
  generate(prompt: string, tier: ModelTier, system?: string): Promise<ProviderResult>;
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
  const key = getSecret(envVarName) ?? dataDrivenEnv(envVarName);
  if (!key) {
    throw new Error(
      `${envVarName} isn't available. Purix does not ship or bill against a shared key — ` +
        `bring your own for ${providerLabel}. Run "purix secret set ${envVarName} <value>" (stored ` +
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
  return dataDrivenEnv(envKey) ?? def.models[tier];
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
    isTransientError: transientCheck,
    async generate(prompt, tier, system) {
      const key = resolveKey(def.keyEnvVar, def.label);
      const model = modelOverride(def, tier);
      const messages = system
        ? [{ role: "system", content: system }, { role: "user", content: prompt }]
        : [{ role: "user", content: prompt }];
      const res = await netFetch("llm-provider", `${def.baseUrl!.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw httpError(`${def.label} ${res.status}: ${providerErrorBody(body)}`, res.status);
      }
      const data = asObject(await res.json());
      const usage = asObject(data.usage);
      return {
        text: textOfContent(asObject(asObject(asArray(data.choices)[0]).message).content),
        usage: {
          inputTokens: tokenCount(usage.prompt_tokens),
          outputTokens: tokenCount(usage.completion_tokens),
          ...cachedField(asObject(usage.prompt_tokens_details).cached_tokens),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Native Gemini adapter (Google's generateContent REST endpoint, through the network door).
// It used to load @google/genai, whose client opens its own connections and so bypassed netFetch; the
// REST call below is the same request, and the key travels in a header, never in the URL.
// ---------------------------------------------------------------------------
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
function geminiAdapter(def: ProviderDefinition): LlmProvider {
  return {
    id: def.id,
    modelFor: (tier) => modelOverride(def, tier),
    isTransientError: transientCheck,
    async generate(prompt, tier, system) {
      const key = resolveKey(def.keyEnvVar, def.label);
      const model = modelOverride(def, tier);
      const res = await netFetch("llm-provider", `${GEMINI_ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw httpError(`Gemini ${res.status}: ${providerErrorBody(body)}`, res.status);
      }
      const data = asObject(await res.json());
      const meta = asObject(data.usageMetadata);
      const text = asArray(asObject(asObject(asArray(data.candidates)[0]).content).parts)
        .map(asObject)
        .filter((p) => typeof p.text === "string" && !p.thought)
        .map((p) => p.text as string)
        .join("");
      return {
        text,
        usage: {
          inputTokens: tokenCount(meta.promptTokenCount),
          outputTokens: tokenCount(meta.candidatesTokenCount),
          ...cachedField(meta.cachedContentTokenCount),
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
    isTransientError: transientCheck,
    async generate(prompt, tier, system) {
      const key = resolveKey(def.keyEnvVar, def.label);
      const model = modelOverride(def, tier);
      const res = await netFetch("llm-provider", "https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw httpError(`Anthropic ${res.status}: ${providerErrorBody(body)}`, res.status);
      }
      const data = asObject(await res.json());
      const usage = asObject(data.usage);
      const text = asArray(data.content)
        .map(asObject)
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      return {
        text,
        usage: {
          inputTokens: tokenCount(usage.input_tokens),
          outputTokens: tokenCount(usage.output_tokens),
          ...cachedField(usage.cache_read_input_tokens),
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
// point it at whatever" escape hatch: `purix provider set custom` with
// --base-url/--key-env/--model-low/--model-high covers vendor #101 (and
// #102, #103...) without ever touching this file again.
// ---------------------------------------------------------------------------
interface PersistedProviderConfig {
  provider: string;
  custom?: { baseUrl: string; keyEnvVar: string; modelLow: string; modelHigh: string; label?: string };
}

// Project-local by design (it lives in the project's .purix/). It is resolved from the working
// directory at call time; callers that know the project root (tests, an MCP session started
// elsewhere) pass baseDir so a subdirectory or a differently-rooted process cannot read or write
// the wrong file (PURIX-17 P1-B).
function configPath(baseDir: string = process.cwd()): string {
  return join(purixDir(baseDir), "provider-config.json");
}

// ---------------------------------------------------------------------------
// Trust for a project's custom endpoint (periodic security check 2026-10-15, poc1).
//
// provider-config.json lives in the PROJECT, so a repository someone else wrote can carry a "custom" block that names any
// URL and any environment variable. Purix would then send the request, with whichever key that variable holds (an
// OPENAI_API_KEY the user set for real work), to the URL in the file, along with the code in the prompt. The fix is a
// record the project cannot write: the user's own state folder lists the endpoint + key-variable pairs the person has
// accepted. `purix provider set custom` records one (the person just typed it); `purix provider trust` accepts one that
// came with a project; nothing else does. A custom block that is not on the list is refused before any key is read.
// The record is keyed by the pair, not the project, so a moved or re-cloned folder keeps working.
// ---------------------------------------------------------------------------
interface TrustFile {
  schema: 1;
  endpoints: string[];
}

function trustFilePath(): string {
  return join(userStateDir(), "trusted-custom-providers.json");
}

/** Where a custom provider would send the key, reduced to a comparable form: scheme, lower-cased host, port and path, no trailing slash. */
function normalizedEndpoint(baseUrl: string): string {
  try {
    const u = new URL(baseUrl.trim());
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  }
}

export function customEndpointFingerprint(cfg: { baseUrl: string; keyEnvVar: string }): string {
  return createHash("sha256").update(`${normalizedEndpoint(cfg.baseUrl)}\n${cfg.keyEnvVar}`).digest("hex");
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** A key may go to an https address, or to this machine over http (a local model server). Anything else would send it in the clear. */
export function assertCustomEndpointTransport(baseUrl: string): void {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`The custom provider address "${baseUrl}" is not a valid URL.`);
  }
  if (u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname))) return;
  throw new Error(`The custom provider address ${baseUrl} would send your API key without encryption. Use an https address (plain http is only allowed for this machine).`);
}

function readTrust(): string[] {
  const read = readJsonFile<TrustFile>(trustFilePath());
  if (read.kind !== "ok" || read.value?.schema !== 1 || !Array.isArray(read.value.endpoints)) return [];
  return read.value.endpoints.filter((e) => typeof e === "string");
}

export function isCustomProviderTrusted(cfg: { baseUrl: string; keyEnvVar: string }): boolean {
  return readTrust().includes(customEndpointFingerprint(cfg));
}

/** Records that the person accepts sending the key named by `keyEnvVar` to `baseUrl`. Only the CLI calls this, after the person says yes. */
export function trustCustomProvider(cfg: { baseUrl: string; keyEnvVar: string }): void {
  assertCustomEndpointTransport(cfg.baseUrl);
  const fp = customEndpointFingerprint(cfg);
  const current = readTrust();
  if (current.includes(fp)) return;
  writeJsonAtomic(trustFilePath(), { schema: 1, endpoints: [...current, fp] } satisfies TrustFile);
}

/** What a project's own provider-config.json asks for, for display. Undefined when it holds no custom block. */
export function projectCustomProvider(baseDir: string = process.cwd()): { baseUrl: string; keyEnvVar: string; trusted: boolean } | undefined {
  const c = readPersistedConfig(baseDir)?.custom;
  if (!c || typeof c.baseUrl !== "string" || typeof c.keyEnvVar !== "string") return undefined;
  return { baseUrl: c.baseUrl, keyEnvVar: c.keyEnvVar, trusted: isCustomProviderTrusted(c) };
}

function readPersistedConfig(baseDir: string = process.cwd()): PersistedProviderConfig | null {
  try {
    const p = configPath(baseDir);
    if (!existsSync(p)) return null;
    return persistedConfigFrom(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return null;
  }
}

/**
 * H1: the file lives in the project, so it may hold anything. A file that is not an object with a text `provider` is read as absent; a
 * `custom` block that lacks any of its four text fields is dropped (a half-filled custom endpoint is never half-used).
 */
function persistedConfigFrom(raw: unknown): PersistedProviderConfig | null {
  const o = asObject(raw);
  if (typeof o.provider !== "string") return null;
  const c = asObject(o.custom);
  const custom =
    typeof c.baseUrl === "string" && typeof c.keyEnvVar === "string" && typeof c.modelLow === "string" && typeof c.modelHigh === "string"
      ? { baseUrl: c.baseUrl, keyEnvVar: c.keyEnvVar, modelLow: c.modelLow, modelHigh: c.modelHigh, ...(typeof c.label === "string" ? { label: c.label } : {}) }
      : undefined;
  return { provider: o.provider, ...(custom ? { custom } : {}) };
}

// Part 2 (hot reload): mtimeMs of provider-config.json at the moment it was
// last read, or null if the file doesn't exist. Used below to detect a
// change made by ANOTHER process (e.g. `purix provider set custom ...` run
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
  const fromEnv = purixEnv("PURIX_LLM_PROVIDER");
  if (fromEnv) return fromEnv;
  const config = readPersistedConfig();
  if (!config) {
    throw new Error(
      `No LLM provider is configured. Run "purix provider list" to see the registry, ` +
      `and "purix provider set <id>" to configure one.`
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
 * that first snapshot forever — even after a separate `purix provider set
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
        `No custom provider is configured. Run: purix provider set custom --base-url <url> ` +
          `--key-env <ENV_VAR_NAME> --model-low <id> --model-high <id>`
      );
    }
    if (cfg.custom.baseUrl) assertCustomEndpointTransport(cfg.custom.baseUrl);
    if (cfg.custom.baseUrl && !isCustomProviderTrusted(cfg.custom)) {
      throw new Error(
        `This project's provider-config.json sends requests, and the key named ${cfg.custom.keyEnvVar}, to ${cfg.custom.baseUrl}, ` +
          `and you have not accepted that endpoint. A project folder can contain this file without you writing it, so Purix will not use it yet. ` +
          `If you set it up yourself, run: purix provider trust   (it shows the address and asks first). Otherwise remove the "custom" block.`
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
      `Unknown LLM provider "${wanted}". Run "purix provider list" to see the registry, or ` +
        `"purix provider set custom ..." to point at any OpenAI-compatible endpoint not yet in it.`
    );
  }
  _active = buildAdapter(def);
  _activeId = wanted;
  _customConfigMtimeAtBuild = null;
  return _active;
}

export type ProviderKeySource = "stored" | "environment" | "missing";

export interface ProviderKeyStatus {
  /** The variable name the provider's key is looked up under, for example OPENAI_API_KEY. */
  envVar: string;
  /** Where the key was found. Never the key itself. */
  source: ProviderKeySource;
}

/**
 * Where a provider's API key would come from, without reading it out or making a call. Same lookup
 * order as the real call (the encrypted store first, then the environment), so the answer matches what
 * the first request will do. It says nothing about whether the provider accepts the key. Returns
 * undefined for a provider that is not configured (an unknown id, or "custom" with no custom block).
 */
export function providerKeyStatus(id?: string): ProviderKeyStatus | undefined {
  const wanted = id ?? activeProviderId();
  let envVar: string | undefined;
  if (wanted === "custom") envVar = readPersistedConfig()?.custom?.keyEnvVar;
  else envVar = REGISTRY_BY_ID.get(wanted)?.keyEnvVar;
  if (!envVar) return undefined;
  let stored: string | null | undefined;
  try {
    stored = getSecret(envVar);
  } catch {
    stored = undefined; // an unreadable store must not crash a status command; fall through to the environment
  }
  if (stored) return { envVar, source: "stored" };
  if (dataDrivenEnv(envVar)) return { envVar, source: "environment" };
  return { envVar, source: "missing" };
}

export function persistProviderChoice(id: string, baseDir: string = process.cwd()): void {
  if (id !== "custom" && !REGISTRY_BY_ID.has(id)) {
    throw new Error(`Unknown provider "${id}". Run "purix provider list" to see supported ids.`);
  }
  const path = configPath(baseDir);
  if (readJsonFile(path).kind === "corrupt") quarantineCorruptFile(path);
  const existing = readPersistedConfig(baseDir);
  writeJsonAtomic(path, { ...existing, provider: id });
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
}, baseDir: string = process.cwd()): void {
  const path = configPath(baseDir);
  if (readJsonFile(path).kind === "corrupt") quarantineCorruptFile(path);
  if (cfg.baseUrl) assertCustomEndpointTransport(cfg.baseUrl); // an empty address is reported by the adapter, with its own message
  writeJsonAtomic(path, { provider: "custom", custom: cfg });
  if (cfg.baseUrl) trustCustomProvider(cfg); // the person just typed this endpoint, so it is their choice
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
      keyEnvVar: "(configured via provider set custom)",
    },
  ];
}
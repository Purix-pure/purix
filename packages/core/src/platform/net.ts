// packages/core/src/platform/net.ts
//
// PURIX-21 G8 / D11(c): the one door for network egress from core. Every outbound HTTP request goes
// through `netFetch`, which makes the destination readable in one place (ADR-001: repository content
// never leaves the machine; what does leave is an LLM prompt after DLP scrubbing, a webhook notice, or
// a licensing call, and each of those names itself with a `purpose`).
//
// What the door does, and does not do:
//   - Requires a `purpose` from a closed set, so an unexplained request cannot be written.
//   - Refuses a malformed URL, a scheme other than http(s), and a URL carrying credentials.
//   - Refuses plain http to a public host. Plain http is allowed to loopback and private-network
//     addresses, which is what a local model server (Ollama, LM Studio) or an office LAN needs. The
//     refusal is there because these requests carry API keys and prompts.
//   - Applies a default timeout when the caller supplies no abort signal.
//   - Tells registered observers which host, purpose and method were used. It never passes headers or
//     bodies to an observer, so an observer cannot leak a key or a prompt.
// It does NOT inspect or scrub bodies (the DLP layer does that before a prompt reaches here). No SDK
// that opens its own connections may be used in core: the Gemini adapter now calls the REST endpoint
// through this door, and ratchet rule R2 also counts imports of network SDKs (see scripts/check-single-point.ts).
//
// The request is made with `globalThis.fetch` read at call time, so tests can stub it.
import { isIP } from "node:net";
import { purixEnv } from "./env.js";

// "dependency-lookup" (F03-03, D-q): names and versions of dependencies a change adds, sent to a package registry or to OSV. Opt-in
// (PURIX_DEP_LOOKUP); never carries repository content, headers or credentials.
export type EgressPurpose = "llm-provider" | "webhook" | "purix-api" | "dependency-lookup";

export interface EgressEvent {
  purpose: EgressPurpose;
  method: string;
  host: string;
  protocol: "http:" | "https:";
}

export class EgressRefusedError extends Error {
  constructor(
    public readonly purpose: EgressPurpose,
    public readonly reason: string
  ) {
    super(`Network request refused (${purpose}): ${reason}`);
    this.name = "EgressRefusedError";
  }
}

const PURPOSES: ReadonlySet<string> = new Set<EgressPurpose>(["llm-provider", "webhook", "purix-api", "dependency-lookup"]);
// Only a ceiling against a hung connection, not a latency budget: a slow local model may take minutes.
// A10c-1: the model-provider ceiling was 10 minutes, so one hung call held a change for 10 minutes and, with the retries a repair
// loop makes, for most of an hour (research 15, finding 7). It is now 3 minutes, and PURIX_LLM_TIMEOUT_MS overrides it.
// PROVISIONAL: 180 s is my choice, not a measurement. Research 15 has no latency distribution for real calls; replace it when
// there is one (the call log already stores latency).
export const DEFAULT_LLM_TIMEOUT_MS = 180_000;
const DEFAULT_TIMEOUT_MS: Record<Exclude<EgressPurpose, "llm-provider">, number> = { webhook: 10_000, "purix-api": 30_000, "dependency-lookup": 8_000 };

/** Deadline for one model-provider request, in milliseconds: PURIX_LLM_TIMEOUT_MS when it is a positive number, else the default. */
export function llmTimeoutMs(): number {
  const n = Number(purixEnv("PURIX_LLM_TIMEOUT_MS"));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_LLM_TIMEOUT_MS;
}
function timeoutFor(purpose: EgressPurpose): number {
  return purpose === "llm-provider" ? llmTimeoutMs() : DEFAULT_TIMEOUT_MS[purpose];
}

const observers = new Set<(e: EgressEvent) => void>();

/** Register an observer of outbound requests. Returns the function that removes it. */
export function onEgress(fn: (e: EgressEvent) => void): () => void {
  observers.add(fn);
  return () => observers.delete(fn);
}

/**
 * True for hosts where plain http is acceptable: loopback, private and link-local addresses, shared
 * address space used by VPNs (100.64.0.0/10, for example Tailscale), and names that only resolve inside
 * a private network (single-label names such as a Docker Compose service, host.docker.internal, and the
 * reserved suffixes .local, .internal, .lan, .home.arpa). Local model servers are normally reached this
 * way (Ollama listens on 127.0.0.1:11434 by default). A public name is never accepted over plain http.
 */
export function isLocalOrPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "host.docker.internal") return true;
  const kind = isIP(h);
  if (kind === 4) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return (
      a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (kind === 6) {
    return h === "::1" || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  }
  if (!h.includes(".")) return h.length > 0; // single-label name: cannot be a public DNS name
  return [".local", ".internal", ".lan", ".home.arpa"].some((suffix) => h.endsWith(suffix));
}

export function checkEgress(purpose: EgressPurpose, rawUrl: string): URL {
  if (!PURPOSES.has(purpose)) throw new EgressRefusedError(purpose, "unknown purpose");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressRefusedError(purpose, "the address is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EgressRefusedError(purpose, `scheme "${url.protocol}" is not allowed, only http and https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new EgressRefusedError(purpose, "the address contains a user name or password; send credentials in a header");
  }
  if (url.protocol === "http:" && !isLocalOrPrivateHost(url.hostname)) {
    throw new EgressRefusedError(purpose, `plain http to ${url.hostname} would send keys and prompts unencrypted; use https`);
  }
  return url;
}

export async function netFetch(purpose: EgressPurpose, rawUrl: string, init: RequestInit = {}): Promise<Response> {
  const url = checkEgress(purpose, rawUrl);
  const method = (init.method ?? "GET").toUpperCase();
  const event: EgressEvent = { purpose, method, host: url.host, protocol: url.protocol as "http:" | "https:" };
  for (const fn of observers) {
    try {
      fn(event);
    } catch {
      // an observer must never break the request it observes
    }
  }
  const withSignal: RequestInit = init.signal ? init : { ...init, signal: AbortSignal.timeout(timeoutFor(purpose)) };
  return fetchFollowingSafeRedirects(purpose, url, method, withSignal);
}

const MAX_SAFE_REDIRECTS = 3;

/**
 * One-day security fix (L1, "Purix Security After the Plan"): fetch follows redirects by default, so a provider URL, a webhook or the
 * Purix API could answer "go to another host" and the request (with its Authorization header and prompt body) would follow. Redirects
 * are now handled here, one hop at a time:
 *  - a redirect to a different host or port, to a scheme other than https/http, or from https down to http, is refused;
 *  - a redirect to the same origin is followed for GET/HEAD, and for any method on 307/308 (which keep the method and body);
 *  - a 301/302/303 answer to a request that sent a body is returned to the caller unfollowed, so nothing is re-sent.
 */
async function fetchFollowingSafeRedirects(purpose: EgressPurpose, start: URL, method: string, init: RequestInit): Promise<Response> {
  let url = start;
  for (let hop = 0; ; hop++) {
    const res = await globalThis.fetch(url.toString(), { ...init, redirect: "manual" });
    const status = typeof res.status === "number" ? res.status : 0;
    if (status < 300 || status >= 400 || status === 304) return res;
    const location = res.headers?.get?.("location");
    if (!location) return res;
    let next: URL;
    try {
      next = checkEgress(purpose, new URL(location, url).toString());
    } catch (e) {
      if (e instanceof EgressRefusedError) throw e;
      throw new EgressRefusedError(purpose, "the server sent a redirect to an address that is not a valid URL");
    }
    if (next.origin !== url.origin) {
      throw new EgressRefusedError(purpose, `the server tried to redirect to ${next.host}. Purix does not follow a redirect to another address, because the request carries keys and prompts.`);
    }
    const keepsMethod = status === 307 || status === 308;
    const safeToFollow = keepsMethod || method === "GET" || method === "HEAD";
    if (!safeToFollow) return res;
    if (hop >= MAX_SAFE_REDIRECTS) throw new EgressRefusedError(purpose, "too many redirects");
    url = next;
  }
}

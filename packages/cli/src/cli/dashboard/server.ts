// src/cli/dashboard/server.ts
//
// The dashboard's request handling. `handleRequest` is a pure function of a described request and a data source, so every protection
// below is tested without opening a socket. `startDashboard` wraps it in a node:http server bound to 127.0.0.1.
//
// Protections (plan, "Protection from web pages"):
//   - loopback only, random port, one-time token. The token arrives once in the URL, is swapped for an HttpOnly SameSite=Strict cookie
//     and a redirect that drops it from the address bar. Without the token or the cookie: 403.
//   - the Host header must be 127.0.0.1 or localhost on this server's port (stops DNS-rebinding pages).
//   - GET and HEAD only. There is no endpoint that writes, so no page in any tab can change anything.
//   - no CORS headers, a Content-Security-Policy that forbids scripts, framing and form posts, no-store caching.
//   - a project is reached only by the id of an entry in the registry, never by a path from the URL.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { renderHome, renderHow, renderNotFound, renderProject, renderReceipt, renderTelemetry, parseView, sinceOf, type DashboardSource, type ProjectRef } from "./pages.js";

export const COOKIE_NAME = "purix_dash";

export interface DashRequest { method: string; url: string; host: string | undefined; cookie: string | undefined }
export interface DashResponse { status: number; headers: Record<string, string>; body: string }

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function projectId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 10);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim();
  }
  return null;
}

function reply(status: number, body: string, type = "text/html; charset=utf-8", extra: Record<string, string> = {}): DashResponse {
  return { status, headers: { "Content-Type": type, ...SECURITY_HEADERS, ...extra }, body };
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function handleRequest(req: DashRequest, src: DashboardSource, token: string, port: number): DashResponse {
  if (!hostAllowed(req.host, port)) return reply(403, "Forbidden: unexpected Host header.", "text/plain; charset=utf-8");
  if (req.method !== "GET" && req.method !== "HEAD") return reply(405, "This dashboard is read-only.", "text/plain; charset=utf-8", { Allow: "GET, HEAD" });
  let url: URL;
  try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch { return reply(400, "Bad request.", "text/plain; charset=utf-8"); }

  const given = url.searchParams.get("t");
  if (given !== null) {
    if (!safeEqual(given, token)) return reply(403, "Forbidden: wrong token.", "text/plain; charset=utf-8");
    url.searchParams.delete("t");
    const rest = url.searchParams.toString();
    return { status: 302, headers: { Location: url.pathname + (rest ? `?${rest}` : ""), "Set-Cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`, ...SECURITY_HEADERS }, body: "" };
  }
  const c = cookieValue(req.cookie);
  if (c === null || !safeEqual(c, token)) return reply(403, "Forbidden: open the address `purix dashboard` printed, which carries the one-time token.", "text/plain; charset=utf-8");

  const view = parseView(url.searchParams);
  const path = url.pathname;
  if (path === "/") return reply(200, renderHome(src, view));
  if (path === "/how") return reply(200, renderHow(src));
  if (path === "/telemetry") return reply(200, renderTelemetry(src));
  const m = /^\/p\/([0-9a-f]{10})(?:\/(c\/([A-Za-z0-9-]{1,40})|export\.json))?$/.exec(path);
  if (m) {
    const p: ProjectRef | undefined = src.projects().find((x) => x.id === m[1]);
    if (!p) return reply(404, renderNotFound(src));
    if (!m[2]) return reply(200, renderProject(src, p, view));
    if (m[3]) return reply(200, renderReceipt(src, p, m[3], view));
    const ledger = src.openLedger(p);
    if (!ledger) return reply(404, JSON.stringify({ error: "no readable record" }), "application/json; charset=utf-8");
    try {
      const data = ledger.exportAll({ since: sinceOf(view.range, src.now()) });
      return reply(200, JSON.stringify({ purixVersion: src.version, exportedAt: src.now().toISOString(), project: p.name, ...data }, null, 2), "application/json; charset=utf-8", { "Content-Disposition": `attachment; filename="purix-${p.id}.json"` });
    } finally { ledger.close(); }
  }
  return reply(404, renderNotFound(src));
}

export interface RunningDashboard { url: string; port: number; token: string; close(): Promise<void> }

export async function startDashboard(src: DashboardSource, opts: { port?: number } = {}): Promise<RunningDashboard> {
  const token = randomBytes(24).toString("base64url");
  let port = 0;
  const server: Server = createServer((req, res) => {
    let out: DashResponse;
    try {
      out = handleRequest({ method: req.method ?? "GET", url: req.url ?? "/", host: req.headers.host, cookie: req.headers.cookie }, src, token, port);
    } catch {
      out = reply(500, "The dashboard could not read a record. Reload in a moment.", "text/plain; charset=utf-8");
    }
    res.writeHead(out.status, out.headers);
    res.end(req.method === "HEAD" ? undefined : out.body);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => resolveListen());
  });
  port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/?t=${token}`, port, token, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }) };
}

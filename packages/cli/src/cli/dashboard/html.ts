// src/cli/dashboard/html.ts
//
// Page shell, styles and small formatters for `purix dashboard`. The pages are plain server-rendered HTML with inline CSS: no script,
// no CDN, no font download, no image, so the dashboard works offline and the Content-Security-Policy can forbid scripts outright.
//
// Style rules taken from the plan (docs: "Rules for showing them"): neutral numbers, one accent colour for the one kind of thing that
// needs a person (a request waiting for approval), no red/green scoring, no score out of 100, every number labelled measured or
// estimated with a link to how it is computed.

/** Escapes text for HTML content and attribute values. Every value that came from the project goes through this. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export type MetricType = "measured" | "estimated" | "needs data" | "not measured";

export const CSS = `
:root{color-scheme:light dark;--bg:#f7f7f5;--panel:#fff;--ink:#1c1c1a;--mute:#6b6b66;--line:#e3e3de;--accent:#b45309;--accent-bg:#fef3e2;--bar:#4b5563;--pill:#eeeeea}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#151514;--panel:#1d1d1b;--ink:#ececE8;--mute:#9a9a93;--line:#2e2e2a;--accent:#f0a24a;--accent-bg:#2b2112;--bar:#9ca3af;--pill:#272724}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:inherit}
.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 48px}
header.top{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:baseline;justify-content:space-between;margin-bottom:18px}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:28px 0 10px}h3{font-size:14px;margin:0 0 6px}
.mute{color:var(--mute)}.small{font-size:13px}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.tile,.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.tile .n{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
.tile .l{color:var(--mute);font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card h3 a{text-decoration:none}.card h3 a:hover{text-decoration:underline}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:8px 0 0;font-size:14px}.kv dt{color:var(--mute)}.kv dd{margin:0;font-variant-numeric:tabular-nums}
.pill{display:inline-block;font-size:11px;line-height:1;padding:3px 6px;border-radius:99px;background:var(--pill);color:var(--mute);margin-left:6px;vertical-align:middle;text-decoration:none}
.attn-text{color:var(--accent);font-weight:600}
.attn{background:var(--accent-bg);color:var(--accent);border:1px solid var(--accent);border-radius:6px;padding:6px 8px;margin-top:10px;font-size:13px}
.bar{height:8px;border-radius:4px;background:var(--pill);overflow:hidden;margin:6px 0 2px}.bar>i{display:block;height:100%;background:var(--bar)}
nav.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:18px 0 12px}
nav.tabs a{padding:5px 10px;border:1px solid var(--line);border-radius:6px;text-decoration:none;font-size:14px;background:var(--panel)}
nav.tabs a[aria-current=page]{border-color:var(--ink);font-weight:600}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0}
.filters a{padding:3px 9px;border:1px solid var(--line);border-radius:99px;text-decoration:none;font-size:13px;background:var(--panel)}
.filters a[aria-current=true]{border-color:var(--ink);font-weight:600}
.panels{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
table{width:100%;border-collapse:collapse;font-size:14px;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:500;font-size:13px}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.table-wrap{overflow-x:auto}
pre.receipt{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px;overflow-x:auto;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap}
.note{border-left:3px solid var(--line);padding:2px 0 2px 10px;color:var(--mute);font-size:13px;margin:10px 0}
footer{margin-top:32px;color:var(--mute);font-size:12px}
`;

export interface PageOptions { title: string; version: string; body: string; liveSeconds?: number }

export function page(o: PageOptions): string {
  const refresh = o.liveSeconds ? `<meta http-equiv="refresh" content="${Math.max(2, Math.floor(o.liveSeconds))}">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${esc(o.title)}</title><style>${CSS}</style></head><body><div class="wrap">${o.body}<footer>Purix ${esc(o.version)} · read-only view of records on this machine · nothing on this page is sent anywhere</footer></div></body></html>`;
}

export function pill(type: MetricType, anchor?: string): string {
  const inner = esc(type);
  return anchor ? `<a class="pill" href="/how#${esc(anchor)}" title="how this is computed">${inner}</a>` : `<span class="pill">${inner}</span>`;
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "not recorded";
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

export function ms(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "not recorded";
  if (n < 1000) return `${Math.round(n)} ms`;
  const s = n / 1000;
  if (s < 90) return `${s.toFixed(1)} s`;
  const m = s / 60;
  return m < 90 ? `${m.toFixed(1)} min` : `${(m / 60).toFixed(1)} h`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function int(n: number): string { return n.toLocaleString("en-US"); }

// src/security/secrets.ts

// Shared list (ADR-003): a match here blocks a write (scanForSecrets) AND is redacted before text leaves the machine
// (scrubSecrets). Only formats with a distinctive shape belong here, because a false match blocks a person's change.
// A7-1 added the vendor token formats, the dotted ones (SendGrid, JWT) and every PEM private key header form.
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Google/Gemini API key", re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: "Private key block", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "Generic bearer token", re: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
  { name: "Generic key/secret assignment", re: /(api|secret|access)[_-]?key\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i },
  { name: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/ },
  { name: "npm token", re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Stripe key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { name: "OpenAI/Anthropic key", re: /\bsk-(?:proj-|ant-[A-Za-z0-9]+-)?[A-Za-z0-9_-]{32,}/ },
  { name: "SendGrid key", re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { name: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "Twilio key", re: /\bSK[0-9a-f]{32}\b/ },
  // A7-1 extension: vendor formats with a distinctive prefix and a long tail (model providers, registries, cloud and SaaS).
  { name: "GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { name: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{30,}/ },
  { name: "PyPI token", re: /\bpypi-AgE[A-Za-z0-9_-]{50,}/ },
  { name: "Docker Hub token", re: /\bdckr_pat_[A-Za-z0-9_-]{20,}/ },
  { name: "Shopify token", re: /\bshp(?:at|ca|pa|ss)_[a-f0-9]{32}\b/ },
  { name: "DigitalOcean token", re: /\bdo[opr]_v1_[a-f0-9]{64}\b/ },
  { name: "Square token", re: /\bsq0(?:atp|csp)-[A-Za-z0-9_-]{22,}/ },
  { name: "Google OAuth client secret", re: /\bGOCSPX-[A-Za-z0-9_-]{28}/ },
  { name: "Telegram bot token", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { name: "Slack app token", re: /\bxapp-\d-[A-Z0-9]{8,}-\d{8,}-[A-Za-z0-9]{20,}/ },
  { name: "Slack webhook URL", re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}/ },
  { name: "Databricks token", re: /\bdapi[0-9a-f]{32}\b/ },
  { name: "Groq key", re: /\bgsk_[A-Za-z0-9]{40,}/ },
  { name: "Replicate token", re: /\br8_[A-Za-z0-9]{36,}/ },
  { name: "Perplexity key", re: /\bpplx-[A-Za-z0-9]{40,}/ },
  { name: "xAI key", re: /\bxai-[A-Za-z0-9]{40,}/ },
  { name: "Linear key", re: /\blin_api_[A-Za-z0-9]{40,}/ },
  { name: "Notion token", re: /\bntn_[A-Za-z0-9]{40,}/ },
  { name: "Atlassian token", re: /\bATATT3[A-Za-z0-9_=-]{60,}/ },
  { name: "Azure storage key", re: /\bAccountKey=[A-Za-z0-9+/]{60,}={0,2}/ },
];

// Context list (A7-1, changed by C1): shapes that are only a secret because of the NAME in front of them (a password literal, a
// key assignment, a URL with a password). They are redacted before a prompt, a reply or an MCP answer leaves, always. They also
// BLOCK a write, but only when the value passes `plausibleSecretValue` below: a placeholder, a word that says "not real", a value
// with no digit or no letter, or a run of one character never blocks. Before C1 these never blocked, so a hard-coded database URL
// or a short password went straight into a commit. The cost of blocking is the false-block risk, which the plausibility rule and the
// legitimate-file test in secrets_blocking_formats.test.ts bound but do not remove. A reviewer who disagrees can move a pattern back
// to SCRUB_ONLY_PATTERNS. This reverses the A7-1 "scrub only, never block" departure from ADR-003 and needs the founder's ratification.
// A placeholder (a value starting with $, {, <, %) is never matched. Every run is length-bounded (a value over 256 characters is
// not matched by the key-assignment rule): an unbounded lookahead made 600 KB of `API_KEY=` take 114 s, found by the stress test. The scheme part of the URL rule is length-capped so a
// long run of letters and dots cannot make it quadratic. Each rule names its value as the group `v`.
const CONTEXT_PATTERNS: { name: string; re: RegExp; minEntropy?: number }[] = [
  { name: "Hardcoded password", re: /\b(?:password|passwd|pwd)\b['"]?\s*[:=]\s*(['"])(?![$<{%])(?<v>[^'"\s]{6,})\1/i },
  {
    name: "Key assignment",
    // A7-1 extension: up to four name segments may come before the keyword (AWS_SECRET_ACCESS_KEY, azure_client_secret). The
    // segments are length-bounded and the match starts only at the start of a name, so a long run of underscores stays linear.
    re: /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,20}[_-]){0,4}(?:api|secret|access|auth|private|client)[_-]?(?:key|token|secret)\b['"]?\s*[:=]\s*(?![$<{%'"])(?=[A-Za-z0-9_+/=-]{20,256}(?:[\s;,]|$))(?=[A-Za-z0-9_+/=-]{0,256}\d)(?<v>[A-Za-z0-9_+/=-]{20,256})/i,
  },
  {
    // An env-file or shell style assignment with no quotes: DB_PASSWORD=value, export PGPASSWORD=value. The value must mix letters
    // and digits (a plain word such as `password=changeme` or a number is left alone) and may not start like a placeholder, hold a call `(` or read as a member access (`req.body.pass1`) or an index access (`parts[2]`). The
    // name prefix and the value are length-bounded and the match starts at the start of a name, so a long run stays linear.
    name: "Unquoted password",
    re: /(?<![A-Za-z0-9])[A-Za-z0-9_-]{0,30}(?:password|passwd|pwd)['"]?[ \t]*[:=][ \t]*(?![$<{%'"])(?![^\s'"]{0,64}\()(?![A-Za-z_][A-Za-z0-9_]{0,30}\.[A-Za-z_])(?![A-Za-z_][A-Za-z0-9_]{0,30}\[)(?=[^\s'"]{6,64}(?:[\s;,]|$))(?=[^\s'"]{0,63}\d)(?=[^\s'"]{0,63}[A-Za-z])(?<v>[^\s'"]{6,64})/i,
  },
  {
    // C1: `token: value` / `AUTH_TOKEN=value` with no quotes (YAML, env files). A bare word `token` is common in code, so the value must be
    // 20 to 128 characters of token characters, may not read as a member access or a call, and must have entropy of 3.5 or more.
    name: "Unquoted token",
    re: /(?<![A-Za-z0-9])(?:[A-Za-z0-9]{1,20}[_-]){0,3}token['"]?[ \t]*[:=][ \t]*(?![$<{%'"])(?![A-Za-z_][A-Za-z0-9_]{0,30}\.[A-Za-z_])(?=[A-Za-z0-9_+/=.-]{20,128}(?:[\s;,]|$))(?<v>[A-Za-z0-9_+/=.-]{20,128})/i,
    minEntropy: 3.5,
  },
  { name: "URL password", re: /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s:/@'"`]+:(?![$<{%])(?<v>[^\s@'"`/]{3,})@/i },
];

// Scrub-only list: a shape that is redacted but never blocks. A redaction that turns out to be wrong costs nothing.
const SCRUB_ONLY_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "Mailgun key", re: /\bkey-[0-9a-f]{32}\b/ },
];

const SCRUB_PATTERNS = [...PATTERNS, ...CONTEXT_PATTERNS, ...SCRUB_ONLY_PATTERNS];
// Compiled once. scrubSecrets used to build a new RegExp for every pattern on every line (about 2 million compilations for a
// 50,000-line file, found by H3 as 4 s on a slow Windows machine). String.prototype.replace with a global regex starts at
// lastIndex 0 and leaves it at 0, so one shared instance is safe to reuse.
const SCRUB_PATTERNS_GLOBAL = SCRUB_PATTERNS.map(({ name, re }) => ({
  name,
  re: new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"),
}));

// Words that say a value is not a real secret. Matched anywhere in the lower-cased value.
const NOT_REAL_WORDS = /password|passwd|secret|changeme|change-me|example|sample|dummy|fake|placeholder|replace|your[-_]|redacted|insecure|localhost|postgres|mysql|mongo|admin|root|default|demo|test|token|xxxx|todo|unset|none|null|undefined/;

/** A value after a secret-looking name is plausible as a real secret: it has a letter and a digit, is not one repeated character, and holds no "not real" word. */
function plausibleSecretValue(v: string, minEntropy = 0): boolean {
  if (!/\d/.test(v) || !/[A-Za-z]/.test(v)) return false;
  if (/^(.)\1+$/.test(v)) return false;
  if (NOT_REAL_WORDS.test(v.toLowerCase())) return false;
  if (minEntropy > 0 && shannonEntropy(v) < minEntropy) return false;
  return true;
}

/** The first context pattern that matches `line` with a plausible value, or undefined. */
function blockingContextMatch(line: string): { name: string; match: string } | undefined {
  for (const { name, re, minEntropy } of CONTEXT_PATTERNS) {
    const m = line.match(re);
    const v = m?.groups?.["v"];
    if (m && v !== undefined && plausibleSecretValue(v, minEntropy)) return { name, match: m[0] };
  }
  return undefined;
}

// C1: a secret written as several string pieces ("AKIA" + "...", or two literals one after the other on the next line) is
// invisible to a per-line scan. A run of 2 to 20 literals joined by `+` or by a line break is folded into one string, and the
// shared PATTERNS and the entropy rule are run on that string. Pieces joined through VARIABLES (`a + b`) are not followed.
interface LiteralRun { start: number; end: number; joined: string; pieces: string[] }
const LITERAL_RE = /(["'])((?:\\.|(?!\1)[^\\\r\n])*)\1/y;
const JOINER_RE = /[ \t]*(?:\+[ \t]*(?:\r?\n[ \t]*)?|\r?\n[ \t]*)/y;

function literalRuns(text: string): LiteralRun[] {
  const runs: LiteralRun[] = [];
  const first = /["']/g;
  let at = 0;
  while (at < text.length) {
    first.lastIndex = at;
    const f = first.exec(text);
    if (!f) break;
    LITERAL_RE.lastIndex = f.index;
    const lit = LITERAL_RE.exec(text);
    if (!lit) { at = f.index + 1; continue; }
    const pieces = [lit[2]!];
    let end = LITERAL_RE.lastIndex;
    while (pieces.length < 20) {
      JOINER_RE.lastIndex = end;
      if (!JOINER_RE.exec(text)) break;
      LITERAL_RE.lastIndex = JOINER_RE.lastIndex;
      const next = LITERAL_RE.exec(text);
      if (!next) break;
      pieces.push(next[2]!);
      end = LITERAL_RE.lastIndex;
    }
    if (pieces.length >= 2) runs.push({ start: f.index, end, joined: pieces.join(""), pieces });
    at = Math.max(end, f.index + 1);
  }
  return runs;
}

/** The shared pattern a run's joined text matches when no single piece does, or undefined. */
function splitSecretName(run: LiteralRun): { name: string; match: string } | undefined {
  for (const { name, re } of PATTERNS) {
    const m = run.joined.match(re);
    if (m && !run.pieces.some((p) => re.test(p))) return { name, match: m[0] };
  }
  if (/^[A-Za-z0-9+/_-]{24,}$/.test(run.joined) && looksLikeToken(run.joined) && !run.pieces.some((p) => p.length >= 24 && looksLikeToken(p))) {
    return { name: "high-entropy string, possible secret", match: run.joined };
  }
  return undefined;
}

// A whole PEM private key, not only its header line: the base64 body is the secret. An unterminated block (a prompt cut
// short, a file truncated) is redacted through the last base64-looking line. The replacement keeps the block's line count so
// line numbers in a prompt stay where they were.
const PEM_BLOCK_RE = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----(?:\r?\n(?:[A-Za-z0-9+/=]{4,}|[A-Za-z-]+: [^\r\n]*|-----END [^\r\n]*-----)[ \t]*)*/g;

/** A quoted run that is only letters has too little to be a token (a long CamelCase identifier); a real random token almost always has a digit. */
// Measured on this repository (858 files): `accounts/fireworks/models/llama-v3p1-8b-instruct` was flagged as a secret because it has a digit and
// entropy above 4.0. A name made of lowercase words joined by `/`, `-`, `_` or `.` is an identifier (a model id, a path, a package name), not a
// token: random tokens are mixed-case or have separators between short digit-bearing chunks. Strings with an uppercase letter are never exempt.
function looksLikeIdentifier(bare: string): boolean {
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(bare)) return false;
  const segments = bare.split(/[._/-]+/).filter((x) => x.length > 0);
  if (segments.length < 3) return false;
  const words = segments.filter((x) => /^[a-z]{3,}$/.test(x)).length;
  return words / segments.length >= 0.6;
}

function looksLikeToken(bare: string): boolean {
  return /\d/.test(bare) && shannonEntropy(bare) > 4.0 && !looksLikeIdentifier(bare);
}

function shannonEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const ch of str) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function redact(s: string): string {
  return s.length <= 8 ? "***" : `${s.slice(0, 4)}...${s.slice(-4)}`;
}

export interface SecretFinding {
  path: string;
  line: number;
  match: string;
  reason: string;
}

export interface ScrubbedFile {
  path: string;
  content: string;
  scrubbedCount: number;
}

/**
 * §E10 (v1.3 DLP scrub, simplified). Distinct job from scanForSecrets:
 * that function BLOCKS a write to real files. This function doesn't
 * block anything — it REDACTS matches in place and always returns
 * content, for the one case where "block" isn't the right verb:
 * dependency-context files that were never themselves a write target,
 * but whose content is about to be sent as prompt text to the
 * escalation LLM (engine/escalate.ts's gatherNeighborContext). A
 * secret sitting in an unrelated neighbor file has no commit to block —
 * without this, it would reach the Gemini API unredacted every time
 * that neighbor happened to be dependency context.
 *
 * Reuses the same PATTERNS list and entropy threshold as
 * scanForSecrets, deliberately — a second, independent copy of "what
 * looks like a secret" is exactly the kind of drift that leaves the
 * scrub catching less than the block does. Global replace (the 'g'
 * flag) here, unlike scanForSecrets' single .match() per line, since
 * this needs to redact every occurrence, not just report the first.
 */
export function scrubSecrets(files: { path: string; content: string }[]): ScrubbedFile[] {
  return files.map((file) => {
    let scrubbedCount = 0;
    const pemScrubbed = file.content.includes("-----BEGIN ")
      ? file.content.replace(PEM_BLOCK_RE, (whole) => {
          scrubbedCount++;
          return `[REDACTED:Private key block]${"\n".repeat(whole.split("\n").length - 1)}`;
        })
      : file.content;
    // C1: a secret written as several string pieces is redacted as a whole run; the line count is kept.
    let content = pemScrubbed;
    if (/["'][ \t]*(?:\+|\r?\n)/.test(pemScrubbed)) {
      const runs = literalRuns(pemScrubbed).filter((r) => splitSecretName(r));
      for (const r of runs.reverse()) {
        const hit = splitSecretName(r)!;
        const newlines = pemScrubbed.slice(r.start, r.end).split("\n").length - 1;
        content = content.slice(0, r.start) + `"[REDACTED:${hit.name}]"${"\n".repeat(newlines)}` + content.slice(r.end);
        scrubbedCount++;
      }
    }
    const lines = content.split("\n").map((line) => {
      let scrubbedLine = line;
      for (const { name, re: globalRe } of SCRUB_PATTERNS_GLOBAL) {
        scrubbedLine = scrubbedLine.replace(globalRe, () => {
          scrubbedCount++;
          return `[REDACTED:${name}]`;
        });
      }
      scrubbedLine = scrubbedLine.replace(/(['"])([A-Za-z0-9+/_-]{24,})(['"])/g, (whole, q1, bare, q2) => {
        if (!looksLikeToken(bare)) return whole;
        scrubbedCount++;
        return `${q1}[REDACTED:high-entropy]${q2}`;
      });
      return scrubbedLine;
    });
    return { path: file.path, content: lines.join("\n"), scrubbedCount };
  });
}

/**
 * Scans proposed file content — NOT the whole repo, just what's about to
 * be written — for known credential formats plus high-entropy quoted
 * strings that look like tokens. This is a heuristic, not Trufflehog:
 * it will miss cleverly-encoded secrets and will occasionally flag a
 * long hash or UUID. It fails closed (blocks the commit) rather than
 * silently letting a real key through, which is the right tradeoff here.
 */
export function scanForSecrets(files: { path: string; content: string }[]): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((line, i) => {
      const matched: string[] = [];
      for (const { name, re } of PATTERNS) {
        const m = line.match(re);
        if (m) {
          matched.push(m[0]);
          findings.push({ path: file.path, line: i + 1, match: redact(m[0]), reason: name });
        }
      }
      const tokenMatches = line.match(/['"]([A-Za-z0-9+/_-]{24,})['"]/g);
      // C1: a name-dependent shape (password literal, key assignment, URL password) blocks only with a plausible value.
      if (matched.length === 0) {
        const ctx = blockingContextMatch(line);
        if (ctx) {
          matched.push(ctx.match);
          findings.push({ path: file.path, line: i + 1, match: redact(ctx.match), reason: ctx.name });
        }
      }
      if (tokenMatches) {
        for (const tok of tokenMatches) {
          const bare = tok.slice(1, -1);
          // A quoted string a named pattern already reported is not reported a second time as high-entropy.
          if (matched.some((m) => bare.includes(m) || m.includes(bare))) continue;
          if (looksLikeToken(bare)) {
            findings.push({
              path: file.path,
              line: i + 1,
              match: redact(bare),
              reason: "high-entropy string, possible secret",
            });
          }
        }
      }
    });
  }
  // C1: secrets written as several string pieces.
  for (const file of files) {
    if (!/["'][ \t]*(?:\+|\r?\n)/.test(file.content)) continue;
    for (const run of literalRuns(file.content)) {
      const hit = splitSecretName(run);
      if (hit) findings.push({ path: file.path, line: file.content.slice(0, run.start).split("\n").length, match: redact(hit.match), reason: `${hit.name} (split across string pieces)` });
    }
  }
  return findings;
}

/**
 * Free-text assignments such as "password=hunter2hunter2" or "token: abc12345".
 * Only used for notes a person or agent types into Repository Memory. It is
 * deliberately NOT part of PATTERNS: scanForSecrets blocks writes to real
 * source files, where an unquoted `token = value` is ordinary code, so adding
 * it there would raise false blocks. A memory note is prose, and a value
 * following one of these words is almost always the secret itself.
 */
const FREE_TEXT_ASSIGNMENT = /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)(\s*[:=]\s*)(?!\[REDACTED)([^\s'",;]{6,})/gi;

/**
 * Redacts secret-shaped values from one free-text string (a memory note). Uses
 * the same PATTERNS and entropy rule as scanForSecrets and scrubSecrets, so
 * there is one definition of what a secret looks like (ADR-003), plus the
 * free-text assignment rule above.
 */
export function scrubFreeText(text: string): { text: string; scrubbedCount: number } {
  const [scrubbed] = scrubSecrets([{ path: "(note)", content: text }]);
  let out = scrubbed!.content;
  let count = scrubbed!.scrubbedCount;
  out = out.replace(FREE_TEXT_ASSIGNMENT, (_whole, key: string, sep: string) => {
    count++;
    return `${key}${sep}[REDACTED:${key.toLowerCase()}]`;
  });
  return { text: out, scrubbedCount: count };
}

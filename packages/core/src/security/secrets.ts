// src/security/secrets.ts

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Google/Gemini API key", re: /AIza[0-9A-Za-z_\-]{35}/ },
  { name: "Private key block", re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "Generic bearer token", re: /Bearer\s+[A-Za-z0-9_\-.]{20,}/ },
  { name: "Generic key/secret assignment", re: /(api|secret|access)[_-]?key\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i },
];

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
    const lines = file.content.split("\n").map((line) => {
      let scrubbedLine = line;
      for (const { name, re } of PATTERNS) {
        const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
        scrubbedLine = scrubbedLine.replace(globalRe, () => {
          scrubbedCount++;
          return `[REDACTED:${name}]`;
        });
      }
      scrubbedLine = scrubbedLine.replace(/(['"])([A-Za-z0-9+/_\-]{24,})(['"])/g, (whole, q1, bare, q2) => {
        if (shannonEntropy(bare) <= 4.0) return whole;
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
      for (const { name, re } of PATTERNS) {
        const m = line.match(re);
        if (m) findings.push({ path: file.path, line: i + 1, match: redact(m[0]), reason: name });
      }
      const tokenMatches = line.match(/['"]([A-Za-z0-9+/_\-]{24,})['"]/g);
      if (tokenMatches) {
        for (const tok of tokenMatches) {
          const bare = tok.slice(1, -1);
          if (shannonEntropy(bare) > 4.0) {
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
  return findings;
}
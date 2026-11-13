// src/security/secrets_vendor_formats.test.ts
//
// A7-1 extension (security review F9; plan A7 target "20 or more of 22 synthetic tokens, at most 1 of 13 false"). A7-1 covered the
// 22-token probe of research 03. This file adds the formats a person using AI coding tools is likely to have in a repository or
// a prompt: the model-provider keys (Hugging Face, Groq, Replicate, Perplexity, xAI), the package and registry tokens (GitLab,
// PyPI, Docker Hub), the cloud and SaaS keys (Azure storage, DigitalOcean, Shopify, Square, Databricks, Telegram, Google OAuth
// client secret, Atlassian, Linear, Notion, Slack app and webhook) and the unquoted AWS secret in an env file.
// Every value here is fake and built from a seed. Rule of the file, as in secrets_formats.test.ts: a format in the SHARED list
// has a distinctive prefix and a long tail, so it blocks a write and is scrubbed; a SCRUB-ONLY format has a shape that could
// occasionally be something else, so it is scrubbed before a prompt leaves and never blocks.
import { describe, it } from "node:test";
import { expect } from "expect";
import { scanForSecrets, scrubSecrets } from "./secrets";

const A = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3kL5mN7pQ9";
const HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const cut = (n: number) => A.slice(0, n);
const hex = (n: number) => HEX.slice(0, n);
const B64 = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6";

const SHARED: { id: string; text: string; secret: string }[] = [
  { id: "gitlab personal access token", text: `GITLAB_TOKEN=glpat-${cut(20)}`, secret: `glpat-${cut(20)}` },
  { id: "hugging face token", text: `HF_TOKEN=hf_${cut(34)}`, secret: `hf_${cut(34)}` },
  { id: "pypi upload token", text: `password = pypi-AgEIcHlwaS5vcmc${cut(55)}`, secret: `pypi-AgEIcHlwaS5vcmc${cut(55)}` },
  { id: "docker hub access token", text: `DOCKER_PAT=dckr_pat_${cut(27)}`, secret: `dckr_pat_${cut(27)}` },
  { id: "shopify admin token", text: `SHOPIFY=shpat_${hex(32)}`, secret: `shpat_${hex(32)}` },
  { id: "digitalocean token", text: `DO=dop_v1_${hex(64)}`, secret: `dop_v1_${hex(64)}` },
  { id: "square access token", text: `SQUARE=sq0atp-${cut(22)}`, secret: `sq0atp-${cut(22)}` },
  { id: "google oauth client secret", text: `client_secret: GOCSPX-${cut(28)}`, secret: `GOCSPX-${cut(28)}` },
  { id: "telegram bot token", text: `BOT=123456789:AA${cut(33)}`, secret: `AA${cut(33)}` },
  { id: "slack app token", text: `SLACK_APP=xapp-1-A0123456789-1234567890123-${hex(40)}`, secret: `xapp-1-A0123456789-1234567890123-${hex(40)}` },
  { id: "slack webhook url", text: `hook: https://hooks.slack.com/services/T01234567/B01234567/${cut(24)}`, secret: `T01234567/B01234567/${cut(24)}` },
  { id: "databricks token", text: `DATABRICKS_TOKEN=dapi${hex(32)}`, secret: `dapi${hex(32)}` },
  { id: "groq key", text: `GROQ=gsk_${cut(52)}`, secret: `gsk_${cut(52)}` },
  { id: "replicate token", text: `REPLICATE=r8_${cut(37)}`, secret: `r8_${cut(37)}` },
  { id: "perplexity key", text: `PPLX=pplx-${cut(48)}`, secret: `pplx-${cut(48)}` },
  { id: "xai key", text: `XAI=xai-${cut(60)}`, secret: `xai-${cut(60)}` },
  { id: "linear api key", text: `LINEAR=lin_api_${cut(40)}`, secret: `lin_api_${cut(40)}` },
  { id: "notion integration token", text: `NOTION=ntn_${cut(46)}`, secret: `ntn_${cut(46)}` },
  { id: "atlassian api token", text: `JIRA=ATATT3xFfGF0${cut(60)}`, secret: `ATATT3xFfGF0${cut(60)}` },
  { id: "azure storage account key in a connection string", text: `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${B64}==;EndpointSuffix=core.windows.net`, secret: B64 },
];

const SCRUB_ONLY: { id: string; text: string; secret: string }[] = [
  { id: "aws secret access key in an env file (unquoted, 40 characters)", text: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  { id: "aws secret access key in a credentials file", text: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  { id: "a prefixed client secret in yaml", text: `azure_client_secret: ${cut(40)}`, secret: cut(40) },
  { id: "a prefixed api token in an env file", text: `SENTRY_AUTH_TOKEN=${cut(48)}`, secret: cut(48) },
  { id: "mailgun key", text: `MAILGUN=key-${hex(32)}`, secret: `key-${hex(32)}` },
];

const BENIGN = [
  // Prefixes that appear in ordinary code, with a tail that is too short or the wrong shape to be a token.
  `const hf = "hf_model_name";`,
  `import { glpat } from "./glpat-helpers";`,
  `const r8 = "r8_ok";`,
  `const x = "gsk_short";`,
  `const doc = "see dop_v1_ in the docs";`,
  `// the dapi prefix marks databricks tokens`,
  `const label = "xai-grok";`,
  `const topic = "pplx-search";`,
  `const lin = "lin_api_docs";`,
  `const ntn = "ntn_x";`,
  // Ordinary key-like names with ordinary values.
  `MAX_TOKENS=100000000000000000000000`,
  `SESSION_TOKEN_TTL=3600`,
  `const secret_key_name = "SECRET_KEY";`,
  `aws_secret_access_key = process.env.AWS_SECRET_ACCESS_KEY`,
  `AWS_SECRET_ACCESS_KEY=\${AWS_SECRET_ACCESS_KEY}`,
  `AWS_SECRET_ACCESS_KEY=<your-secret-access-key>`,
  `AWS_SECRET_ACCESS_KEY=`,
  `api_key_header = "X-API-Key"`,
  `AccountKey=short`,
  `const hook = "https://hooks.slack.com/services/docs";`,
  `token_count = len(tokens)`,
];

describe("vendor secret formats, shared list (blocks a write and is scrubbed)", () => {
  for (const c of SHARED) {
    it(`scan flags ${c.id}`, () => {
      expect(scanForSecrets([{ path: "x", content: c.text }]).length).toBeGreaterThan(0);
    });
    it(`scrub removes ${c.id}`, () => {
      const [out] = scrubSecrets([{ path: "x", content: c.text }]);
      expect(out!.content).not.toContain(c.secret);
      expect(out!.scrubbedCount).toBeGreaterThan(0);
    });
  }
});

describe("vendor secret formats, context list (scrubbed always; C1: also blocks a write when the value is plausible)", () => {
  for (const c of SCRUB_ONLY) {
    it(`scrub removes ${c.id}`, () => {
      const [out] = scrubSecrets([{ path: "x", content: c.text }]);
      expect(out!.content).not.toContain(c.secret);
      expect(out!.scrubbedCount).toBeGreaterThan(0);
    });
    // Still scrub-only after C1: the Mailgun shape (`key-` plus 32 hex, no name in front) and AWS's own published example secret
    // (it contains the word EXAMPLE, which the plausibility rule reads as "not real").
    const stillScrubOnly = /mailgun|aws secret access key/.test(c.id);
    it(`scan ${stillScrubOnly ? "does not block on" : "blocks"} ${c.id}`, () => {
      const n = scanForSecrets([{ path: "x", content: c.text }]).length;
      if (stillScrubOnly) expect(n).toBe(0);
      else expect(n).toBeGreaterThan(0);
    });
  }
});

describe("ordinary strings next to these prefixes stay clean", () => {
  for (const t of BENIGN) {
    it(`leaves alone: ${t.slice(0, 60)}`, () => {
      expect(scanForSecrets([{ path: "x", content: t }])).toEqual([]);
      const [out] = scrubSecrets([{ path: "x", content: t }]);
      expect(out!.content).toBe(t);
      expect(out!.scrubbedCount).toBe(0);
    });
  }
});

describe("the new rules stay fast on hostile input (the 600 KB line that stalled the gate for 43 s)", () => {
  for (const [name, line] of [
    ["a long run of letters and underscores", "a_".repeat(300_000)],
    ["a long run of KEY= with no value", "API_KEY=".repeat(75_000)],
    ["a long run of prefix-like names", "AWS_SECRET_".repeat(55_000)],
    ["a long run of digits and colons", "123456789:".repeat(60_000)],
    ["a long run of hex after a prefix", "dop_v1_" + "0".repeat(600_000)],
    ["a long run of base64 after AccountKey", "AccountKey=" + "A".repeat(600_000)],
  ] as const) {
    it(`${name} is scanned and scrubbed in under 3 seconds`, () => {
      const t0 = Date.now();
      scanForSecrets([{ path: "x", content: line }]);
      scrubSecrets([{ path: "x", content: line }]);
      expect(Date.now() - t0).toBeLessThan(3000);
    });
  }
});

describe("a tally over the whole set, as in the review's probe", () => {
  it("every secret in the two lists is removed by the scrub and no benign line is touched", () => {
    const secrets = [...SHARED, ...SCRUB_ONLY];
    const removed = secrets.filter((c) => !scrubSecrets([{ path: "x", content: c.text }])[0]!.content.includes(c.secret)).length;
    const touched = BENIGN.filter((t) => scrubSecrets([{ path: "x", content: t }])[0]!.scrubbedCount > 0).length;
    expect({ removed, of: secrets.length, benignTouched: touched }).toEqual({ removed: secrets.length, of: secrets.length, benignTouched: 0 });
  });
});

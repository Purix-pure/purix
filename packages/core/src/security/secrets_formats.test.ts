// src/security/secrets_formats.test.ts
//
// A7-1: secret formats the scanner and the outbound scrub must know. Research 03 measured 9 of 22 synthetic tokens caught;
// this set is a reconstruction (the original probe folder was never uploaded), every value is fake and built here.
// Rule of the file: a format that is in the SHARED list (blocks a write AND is scrubbed) is high confidence. A format in the
// SCRUB-ONLY list (password literal, unquoted key=value, URL password) is scrubbed before a prompt leaves the machine but
// never blocks a write, because a false redaction costs nothing and a false block costs an override.
import { describe, it } from "node:test";
import { expect } from "expect";
import { scanForSecrets, scrubSecrets } from "./secrets";

const A = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3kL5mN7pQ9";
const cut = (n: number) => A.slice(0, n);
// Built at runtime so no literal "SK" + 32 hex sits in the source: GitHub push protection flags that shape as a Twilio key.
const TWILIO_FAKE = "SK" + "0123456789abcdef".repeat(2);

const SHARED: { id: string; text: string; secret: string }[] = [
  { id: "github token, unquoted yaml", text: `token: ghp_${cut(36)}`, secret: `ghp_${cut(36)}` },
  { id: "github token, npmrc", text: `//npm.pkg.github.com/:_authToken=ghp_${cut(36)}`, secret: `ghp_${cut(36)}` },
  { id: "github fine-grained token", text: `GH=github_pat_${cut(50)}`, secret: `github_pat_${cut(50)}` },
  { id: "npm token, npmrc", text: `//registry.npmjs.org/:_authToken=npm_${cut(36)}`, secret: `npm_${cut(36)}` },
  { id: "slack token", text: `SLACK=xoxb-1234567890-1234567890123-${cut(24)}`, secret: `xoxb-1234567890-1234567890123-${cut(24)}` },
  { id: "stripe key, unquoted", text: `STRIPE=sk_live_${cut(24)}`, secret: `sk_live_${cut(24)}` },
  { id: "openai project key, unquoted", text: `OPENAI=sk-proj-${cut(48)}`, secret: `sk-proj-${cut(48)}` },
  { id: "anthropic key, unquoted", text: `ANTHROPIC=sk-ant-api03-${cut(60)}`, secret: `sk-ant-api03-${cut(60)}` },
  { id: "sendgrid key (has dots)", text: `SENDGRID_API_KEY=SG.${cut(22)}.${cut(43)}`, secret: `SG.${cut(22)}.${cut(43)}` },
  {
    id: "jwt (has dots)",
    text: "auth: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    secret: "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
  },
  { id: "encrypted private key header", text: "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIE", secret: "-----BEGIN ENCRYPTED PRIVATE KEY-----" },
  { id: "dsa private key header", text: "-----BEGIN DSA PRIVATE KEY-----\nMIIE", secret: "-----BEGIN DSA PRIVATE KEY-----" },
  { id: "pgp private key header", text: "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQVY", secret: "-----BEGIN PGP PRIVATE KEY BLOCK-----" },
  { id: "twilio api key", text: `TWILIO="${TWILIO_FAKE}"`, secret: TWILIO_FAKE },
];

const SCRUB_ONLY: { id: string; text: string; secret: string }[] = [
  { id: "32-char hex under a key name", text: "API_KEY=9f86d081884c7d659a2feaa0c55ad015", secret: "9f86d081884c7d659a2feaa0c55ad015" },
  { id: "password inside a database URL", text: "DATABASE_URL=postgres://app:S3cr3tP4ssw0rd@db.internal:5432/app", secret: "S3cr3tP4ssw0rd" },
  { id: "short quoted password", text: `const password = "hunter2!";`, secret: "hunter2!" },
];

const BENIGN = [
  `const id = "VeryLongDescriptiveIdentifierNameForAComponentRegistry";`,
  `const img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";`,
  `exports[\`snapshot 1\`] = "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=";`,
  `const id = "123e4567-e89b-12d3-a456-426614174000";`,
  `const h = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";`,
  `import { x } from "../../components/shared/VeryDeeplyNestedModulePath/index.js";`,
  `t("settings.notifications.email.digest.frequency.weekly.description")`,
  `const url = "https://example.com/api/v1/users/12345/profile";`,
  `// token: the parser reads one token at a time`,
  `const password = process.env.DB_PASSWORD;`,
  `function getApiKey(): string { return config.apiKey; }`,
  `const secretName = "my-app-prod-db-credentials-name";`,
  `const apiKey = config.apiKey;`,
  `const dsn = "postgres://localhost:5432/app";`,
  `const dsn2 = "postgres://app:\${DB_PASSWORD}@db:5432/app";`,
];

describe("secret formats, shared list (blocks a write and is scrubbed)", () => {
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

describe("secret formats, context list (scrubbed always; C1: also blocks a write when the value is plausible)", () => {
  for (const c of SCRUB_ONLY) {
    it(`scrub removes ${c.id}`, () => {
      const [out] = scrubSecrets([{ path: "x", content: c.text }]);
      expect(out!.content).not.toContain(c.secret);
    });
    it(`scan blocks ${c.id}`, () => {
      expect(scanForSecrets([{ path: "x", content: c.text }]).length).toBeGreaterThan(0);
    });
  }
});

describe("ordinary strings stay clean", () => {
  for (const t of BENIGN) {
    it(`leaves alone: ${t.slice(0, 60)}`, () => {
      expect(scanForSecrets([{ path: "x", content: t }])).toEqual([]);
      const [out] = scrubSecrets([{ path: "x", content: t }]);
      expect(out!.content).toBe(t);
      expect(out!.scrubbedCount).toBe(0);
    });
  }
});

describe("existing behaviour is kept", () => {
  it("an AWS key is still exactly one finding", () => {
    expect(scanForSecrets([{ path: "c.ts", content: `const key = "AKIAIOSFODNN7EXAMPLE";` }]).length).toBe(1);
  });
  it("a long mixed token with digits is still flagged by entropy", () => {
    const f = scanForSecrets([{ path: "c.ts", content: `const token = "xK9mQ2vN8pL4wR7tY1zA5bC3dE6fG0hJ9k";` }]);
    expect(f.some((x) => x.reason.includes("high-entropy"))).toBe(true);
  });
});

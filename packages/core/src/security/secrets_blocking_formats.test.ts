// src/security/secrets_blocking_formats.test.ts
//
// C1 (plan v4, N2 / F03-07): five secret formats that the write scan used to let through and only the outbound scrub removed:
// unquoted values, hex keys, database URLs with a password, short quoted passwords, and a token split across string pieces.
// Every value is fake and built here. The "legitimate" set below was written by the session that wrote this file, not supplied
// by the author of the plan; its size (30 lines) and its labels are the session's, so the false-positive count is a count on
// that set only.
import { describe, it } from "node:test";
import { expect } from "expect";
import { scanForSecrets, scrubSecrets } from "./secrets";

const H = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

interface Probe { id: string; fmt: string; path: string; content: string; secret: string }

const PROBES: Probe[] = [
  { id: "unquoted env password", fmt: "unquoted", path: "a.env", content: "DB_PASSWORD=Xk9mP2qL7vR4", secret: "Xk9mP2qL7vR4" },
  { id: "unquoted yaml token", fmt: "unquoted", path: "a.yml", content: "token: Xk9mP2qL7vR4wZ8nB3cD", secret: "Xk9mP2qL7vR4wZ8nB3cD" },
  { id: "unquoted export", fmt: "unquoted", path: "a.sh", content: "export PGPASSWORD=Xk9mP2qL7vR4", secret: "Xk9mP2qL7vR4" },
  { id: "unquoted ini secret key", fmt: "unquoted", path: "a.ini", content: "secret_key = Xk9mP2qL7vR4wZ8nB3cDeF5g", secret: "Xk9mP2qL7vR4wZ8nB3cDeF5g" },
  { id: "32-char hex under a key name", fmt: "hex", path: "a.env", content: `API_KEY=${H.slice(0, 32)}`, secret: H.slice(0, 32) },
  { id: "40-char hex quoted", fmt: "hex", path: "a.ts", content: `const apiKey = "${H.slice(0, 40)}";`, secret: H.slice(0, 40) },
  { id: "64-char hex quoted", fmt: "hex", path: "a.py", content: `SECRET_KEY = "${H}"`, secret: H },
  { id: "postgres url", fmt: "database URL", path: "a.env", content: "DATABASE_URL=postgres://app:S3cr3tP4ssw0rd@db.internal:5432/app", secret: "S3cr3tP4ssw0rd" },
  { id: "mongodb+srv url", fmt: "database URL", path: "a.ts", content: `const u = "mongodb+srv://admin:Zq81xLmP@cluster0.example.net/db";`, secret: "Zq81xLmP" },
  { id: "mysql url", fmt: "database URL", path: "a.py", content: `URL = "mysql://root:hunter22@10.0.0.5/app"`, secret: "hunter22" },
  { id: "short quoted password, ts", fmt: "short password", path: "a.ts", content: `const password = "hunter2!";`, secret: "hunter2!" },
  { id: "short quoted password, py", fmt: "short password", path: "a.py", content: `PASSWORD = "Tr0ub4"`, secret: "Tr0ub4" },
  { id: "short password in json", fmt: "short password", path: "a.json", content: `{"password": "s3cret99"}`, secret: "s3cret99" },
  { id: "token split by +", fmt: "split across lines", path: "a.ts", content: `const k = "ghp_aB3dE5fG7hJ9kL1mN3pQ5" +\n  "rS7tU9vW1xY3zA5bC7dE9";`, secret: "ghp_aB3dE5fG7hJ9kL1mN3pQ5" },
  { id: "key split by implicit concatenation", fmt: "split across lines", path: "a.py", content: `key = (\n  "sk-proj-aB3dE5fG7hJ9kL1m"\n  "N3pQ5rS7tU9vW1xY3zA5bC7dE9fG1hJ3"\n)`, secret: "sk-proj" },
  { id: "AWS key split in two literals", fmt: "split across lines", path: "a.ts", content: `const key = "AKIAIOSF" + "ODNN7EXAMPLE";`, secret: "AKIAIOSF" },
  { id: "AWS key split in two literals over two lines", fmt: "split across lines", path: "a.ts", content: `const key = "AKIAIOSF" +\n  "ODNN7EXAMPLE";`, secret: "AKIAIOSF" },
];

// Ordinary code and config. Written by the session; none holds a real secret.
const LEGITIMATE: { id: string; path: string; content: string }[] = [
  { id: "compose, env reference with default", path: "docker-compose.yml", content: "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-postgres}" },
  { id: "placeholder password in .env.example", path: ".env.example", content: "DB_PASSWORD=changeme123" },
  { id: "test fixture password", path: "a.test.ts", content: `const password = "password123";` },
  { id: "password from environment", path: "a.py", content: `password = os.environ["DB_PASSWORD"]` },
  { id: "dsn with literal word password", path: "a.ts", content: `const dsn = "postgres://user:password@localhost:5432/app";` },
  { id: "compose default credentials", path: ".env", content: "DATABASE_URL=postgres://postgres:postgres@db:5432/app" },
  { id: "url with short plain user password", path: "a.ts", content: `const url = "https://user:pass@example.com/";` },
  { id: "api key placeholder", path: ".env.example", content: "API_KEY=your-api-key-here1" },
  { id: "replace-me key", path: "a.ts", content: `const api_key = "REPLACE_ME_WITH_KEY_12345";` },
  { id: "github actions token", path: "ci.yml", content: "          token: ${{ secrets.GITHUB_TOKEN }}" },
  { id: "token from a call", path: "a.py", content: `token = tokenizer.next_token()` },
  { id: "token from a member", path: "a.ts", content: `const token = req.headers.authorization123;` },
  { id: "sha256 under a hash name", path: "a.json", content: `"hash": "${H}"` },
  { id: "lockfile integrity", path: "package-lock.json", content: `"integrity": "sha512-Ro3pZBbJ6NJ8eVKJe2uhY3Z1XxkE8nB5Cq4i0fRg9tEw6QmZsYb1uH0nKcLd7vqjQ5aXyT2lWmPoIhGfS9rUeA=="` },
  { id: "secret key from settings", path: "a.py", content: `secret_key = settings.SECRET_KEY` },
  { id: "client secret from a call", path: "a.py", content: `client_secret = get_secret("client")` },
  { id: "short token", path: "a.yml", content: "auth_token: abc" },
  { id: "key path, not a key", path: "a.py", content: `private_key_path = "/etc/ssl/private/server-key-2024.pem"` },
  { id: "min length constant", path: "a.ts", content: `const passwordMinLength = 12;` },
  { id: "schema, call in value", path: "a.ts", content: `password: z.string().min(8),` },
  { id: "html password input", path: "a.html", content: `<input type="password" name="password1">` },
  { id: "field name constant", path: "a.ts", content: `const password_field = "password1234567";` },
  { id: "uuid", path: "a.ts", content: `const id = "123e4567-e89b-12d3-a456-426614174000";` },
  { id: "test user, password word in value", path: "a.ts", content: `const user = { name: "alice", password: "alice-password-1" };` },
  { id: "django dev key", path: "settings.py", content: `SECRET_KEY=django-insecure-dev-key-1234567890abcdefghij` },
  { id: "getpass prompt", path: "a.py", content: `password = getpass.getpass("Password: ")` },
  { id: "jwt secret from env", path: "a.ts", content: `jwt.sign(payload, process.env.JWT_SECRET1)` },
  { id: "curl with local admin", path: "a.sh", content: `curl -u admin:admin123 http://localhost:8080/health` },
  { id: "two short strings joined", path: "a.ts", content: `const label = "Total: " + "items";` },
  { id: "argument list, not a join", path: "a.ts", content: `log("user", "AKIAIOSF");` },
];

const KNOWN_FALSE_POSITIVES = ["replace-me key"];

describe("C1: formats that must block a write", () => {
  for (const p of PROBES) {
    it(`blocks: ${p.id}`, () => {
      expect(scanForSecrets([{ path: p.path, content: p.content }]).length).toBeGreaterThan(0);
    });
  }
});

describe("C1: scrub and gate share one list", () => {
  for (const p of PROBES) {
    it(`whatever blocks is also scrubbed: ${p.id}`, () => {
      const blocked = scanForSecrets([{ path: p.path, content: p.content }]).length > 0;
      const [out] = scrubSecrets([{ path: p.path, content: p.content }]);
      if (blocked) expect(out!.content).not.toContain(p.secret);
    });
  }
});

describe("C1: legitimate files", () => {
  it("raises at most one false positive on the 30-line legitimate set", () => {
    const flagged = LEGITIMATE.filter((l) => scanForSecrets([{ path: l.path, content: l.content }]).length > 0).map((l) => l.id);
    expect(flagged.length).toBeLessThanOrEqual(1);
    // Pinned by name so a regression shows by name, not only by number. The one known false positive is the older
    // "Generic key/secret assignment" rule (api_key = "<16+ letters, digits, _ or ->"), which has no placeholder check. C1 did not change it.
    expect(flagged).toEqual(KNOWN_FALSE_POSITIVES);
  });
  for (const l of LEGITIMATE.filter((x) => !KNOWN_FALSE_POSITIVES.includes(x.id))) {
    it(`does not block: ${l.id}`, () => {
      expect(scanForSecrets([{ path: l.path, content: l.content }])).toEqual([]);
    });
  }
});

describe("C1: stated limits (pinned so they are not mistaken for coverage)", () => {
  it("a token split across VARIABLES is not caught by the write scan", () => {
    const content = `const a = "AKIAIOSF";\nconst b = "ODNN7EXAMPLE";\nconst key = a + b;`;
    expect(scanForSecrets([{ path: "a.ts", content }])).toEqual([]);
  });
  it("a token split across string pieces is removed by the outbound scrub, and the line count is kept", () => {
    const content = `const key = "AKIAIOSF" +\n  "ODNN7EXAMPLE";\nconst n = 1;`;
    const [out] = scrubSecrets([{ path: "a.ts", content }]);
    expect(out!.content).not.toContain("AKIAIOSF");
    expect(out!.content.split("\n").length).toBe(3);
    expect(out!.content).toContain("const n = 1;");
  });
});

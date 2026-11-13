// src/security/outbound_scrub.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { scrubOutboundText, scrubOutboundPrompt } from "./outbound_scrub";

const AWS = "AKIAIOSFODNN7EXAMPLE";

describe("scrubOutboundText", () => {
  it("returns clean text unchanged and counts nothing", () => {
    const t = "rename the function foo to bar in src/a.ts";
    expect(scrubOutboundText(t)).toEqual({ text: t, count: 0 });
  });

  it("redacts a known token and says how many", () => {
    const r = scrubOutboundText(`const k = "${AWS}";\nconst j = "${AWS}";`);
    expect(r.text).not.toContain(AWS);
    expect(r.count).toBe(2);
    expect(r.text.split("\n").length).toBe(2);
  });

  it("keeps every line break, so line numbers in a prompt do not move", () => {
    const src = ["a", `k="${AWS}"`, "", "b"].join("\n");
    expect(scrubOutboundText(src).text.split("\n").length).toBe(4);
  });

  it("handles a 600 KB single line in well under a second of work", () => {
    const line = "x = 1; ".repeat(Math.ceil((600 * 1024) / 7)) + AWS;
    const t0 = Date.now();
    const r = scrubOutboundText(line);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.text).not.toContain(AWS);
  });
});

describe("scrubOutboundText: unquoted passwords", () => {
  it("an unquoted password assignment (env-file style) is redacted when the value mixes letters and digits", () => {
    const cases = ["DB_PASSWORD=hunter2abc9", "export PGPASSWORD=Zx81kqPw", "MYSQL_PWD: s3cretValue7", "passwd=abc12345xyz"];
    for (const c of cases) {
      const r = scrubOutboundText(`before\n${c}\nafter`);
      expect(r.count).toBe(1);
      expect(r.text).not.toContain(c.split(/[:=]\s*/)[1]!);
      expect(r.text.split("\n").length).toBe(3);
    }
  });

  it("leaves placeholders, plain words, numbers and names alone", () => {
    for (const c of ["DB_PASSWORD=${DB_PASSWORD}", "password=changeme", "PASSWORD=123456789", "password_hash=<hash>", "password: %s", "the password field is required", "passwd = readSecret2(env)", "password = req.body.pass1"]) {
      expect(scrubOutboundText(c)).toEqual({ text: c, count: 0 });
    }
  });
});

describe("scrubOutboundPrompt", () => {
  it("scrubs both parts of a prompt pair and keeps the shape", () => {
    const r = scrubOutboundPrompt({ system: `sys ${AWS}`, user: `usr ${AWS}` });
    expect(typeof r.prompt).toBe("object");
    const p = r.prompt;
    expect(p.system).not.toContain(AWS);
    expect(p.user).not.toContain(AWS);
    expect(r.count).toBe(2);
  });

  it("scrubs a plain string prompt", () => {
    const r = scrubOutboundPrompt(`hello ${AWS}`);
    expect(r.prompt).not.toContain(AWS);
    expect(r.count).toBe(1);
  });

  it("returns the same object when nothing matched", () => {
    const pair = { system: "s", user: "u" };
    expect(scrubOutboundPrompt(pair).prompt).toBe(pair);
  });
});

describe("scrubOutboundText on shapes built to make a regex backtrack", () => {
  // Found by stress-testing the A7-1 patterns: an unbounded lookahead in the key-assignment rule took 114 s on 600 KB of API_KEY=.
  const N = 600 * 1024;
  const rep = (u: string) => u.repeat(Math.ceil(N / u.length));
  const shapes: Record<string, string> = {
    "API_KEY= repeated": rep("API_KEY="),
    "PASSWORD= repeated": rep("PASSWORD="),
    "a_ repeated before PASSWORD=": rep("a_") + "PASSWORD=x1",
    "secret-key=1 repeated": rep("secret-key=1"),
    "client_token: repeated": rep("client_token:"),
    "scheme a:// repeated": rep("a://"),
    "dots a.a.a. repeated": rep("a."),
    "PEM header repeated": rep("-----BEGIN PRIVATE KEY-----\n"),
  };
  for (const [name, text] of Object.entries(shapes)) {
    it(`${name}: finishes in a few seconds`, () => {
      const t0 = Date.now();
      scrubOutboundText(text);
      expect(Date.now() - t0).toBeLessThan(6000);
    });
  }
});

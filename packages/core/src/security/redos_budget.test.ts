// H3 (plan v7, 6.4): hostile input must not make the pattern scans hang. Reproduce-only result: no shape tried
// (20 for the code gate, 10 for the secret scan, 6 for the lock parsers) took more than 0.35 s at 400,000 characters,
// so this pins that finding with a generous bound (a hang is minutes, not seconds). It is a tripwire for a future
// regex edit, not a benchmark: the bound is loose on purpose so a slow machine does not fail it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSecurityGate } from "../gates/security_gate.js";
import { scanForSecrets, scrubFreeText } from "./secrets.js";
import { lockPairs, parseLockEntries } from "./lock_parsers.js";

const N = 100_000;
const BOUND_MS = 3_000;

const hostile: Record<string, string> = {
  "one long word": "a".repeat(N),
  "open parens": "exec(" + "(".repeat(N),
  "unterminated string": 'eval("' + "a".repeat(N),
  "key then endless value": "password=" + "a".repeat(N) + " ",
  "key then endless spaces": "password" + " ".repeat(N) + "x",
  "repeated key": "token=".repeat(N / 6),
  "url userinfo": "postgres://" + "u:".repeat(N / 2),
  "adjacent literals": '"abcd""abcd"'.repeat(N / 12),
  "concatenation chain": 'query("SELECT " + '.repeat(N / 20),
  "many lines": "x\n".repeat(N / 2),
  "shell eval": 'eval "$' + "x".repeat(N),
  "pipe chain": "curl " + "a ".repeat(N / 2) + "| ",
};

function timed(f: () => void): number {
  const t = Date.now();
  f();
  return Date.now() - t;
}

describe("H3: hostile input does not hang the scans", () => {
  for (const [name, text] of Object.entries(hostile)) {
    it(`secret scan and scrub: ${name}`, () => {
      const ms = timed(() => {
        scanForSecrets([{ path: "a.ts", content: text }]);
        scrubFreeText(text);
      });
      assert.ok(ms < BOUND_MS, `${name} took ${ms} ms`);
    });
    for (const ext of ["ts", "py", "sh", "md"]) {
      it(`security gate (.${ext}): ${name}`, () => {
        const ms = timed(() => {
          runSecurityGate([{ path: `a.${ext}`, content: text }]);
        });
        assert.ok(ms < BOUND_MS, `${name} .${ext} took ${ms} ms`);
      });
    }
  }

  const locks: Record<string, string> = {
    "yarn.lock": '"a@^1":\n  version "1"\n'.repeat(N / 20),
    "pnpm-lock.yaml": "packages:\n" + "  /a@1:\n    resolution: {integrity: x}\n".repeat(N / 40),
    "poetry.lock": '[[package]]\nname = "a"\nversion = "1"\n'.repeat(N / 40),
    "package-lock.json": '{"dependencies":{' + '"a":"1",'.repeat(N / 8) + '"z":"1"}}',
    "pyproject.toml": 'name = "' + "a".repeat(N),
  };
  for (const [path, text] of Object.entries(locks)) {
    it(`lock reader does not hang or throw: ${path}`, () => {
      const ms = timed(() => {
        parseLockEntries(path, text);
        lockPairs(path, text);
      });
      assert.ok(ms < BOUND_MS, `${path} took ${ms} ms`);
    });
  }
});

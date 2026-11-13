// PURIX-21 D11(d): the environment registry reads live values, and every Purix variable read by core is
// listed in PURIX_ENV (the compiler enforces the type; this test pins the list and the live reads).
import { afterEach, describe, it } from "node:test";
import { expect } from "expect";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AMBIENT_ENV, PURIX_ENV, ambientEnv, dataDrivenEnv, envSnapshot, purixEnv } from "./env";

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in saved)) saved[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
});

describe("env registry", () => {
  it("reads the live value on every call", () => {
    setEnv("PURIX_COST_CEILING_USD", "7");
    expect(purixEnv("PURIX_COST_CEILING_USD")).toBe("7");
    setEnv("PURIX_COST_CEILING_USD", undefined);
    expect(purixEnv("PURIX_COST_CEILING_USD")).toBeUndefined();
  });

  it("reads ambient and data-driven names", () => {
    setEnv("NODE_ENV", "test");
    setEnv("OPENAI_API_KEY", "k");
    expect(ambientEnv("NODE_ENV")).toBe("test");
    expect(dataDrivenEnv("OPENAI_API_KEY")).toBe("k");
    expect(dataDrivenEnv("PURIX_NOT_SET_ANYWHERE")).toBeUndefined();
  });

  it("envSnapshot is the live environment", () => {
    setEnv("PURIX_ENV_TEST_PROBE", "1");
    expect(envSnapshot().PURIX_ENV_TEST_PROBE).toBe("1");
  });

  it("lists each name once, sorted, and Purix names carry the PURIX_ prefix", () => {
    expect(new Set(PURIX_ENV).size).toBe(PURIX_ENV.length);
    expect([...PURIX_ENV]).toEqual([...PURIX_ENV].sort());
    expect([...AMBIENT_ENV]).toEqual([...AMBIENT_ENV].sort());
    for (const n of PURIX_ENV) expect(n.startsWith("PURIX_")).toBe(true);
  });

  it("every purixEnv(\"NAME\") literal in core source is in the registry", () => {
    const root = join(import.meta.dirname, "..");
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
          for (const m of readFileSync(p, "utf8").matchAll(/purixEnv\("([A-Z0-9_]+)"\)/g)) found.add(m[1]!);
        }
      }
    };
    walk(root);
    expect(found.size).toBeGreaterThan(0);
    for (const n of found) expect((PURIX_ENV as readonly string[]).includes(n)).toBe(true);
  });
});

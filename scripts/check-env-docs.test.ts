// scripts/check-env-docs.test.ts: run with `pnpm run env-docs-check:test`.
import { describe, it } from "node:test";
import { expect } from "expect";
import { envNamesInSource, namesFromEnvModule, undocumented } from "./check-env-docs.ts";

describe("envNamesInSource", () => {
  it("finds dotted and bracketed reads, ignores comments and other objects", () => {
    const src = 'const a = process.env.PURIX_A; const b = process.env["PURIX_B"]; // process.env.PURIX_C\nconst c = other.env.PURIX_D; const d = process.env[name];';
    expect(envNamesInSource(src).sort()).toEqual(["PURIX_A", "PURIX_B"]);
  });
});
describe("namesFromEnvModule", () => {
  it("reads the two tuples in platform/env.ts", () => {
    const src = 'export const PURIX_ENV = [\n "PURIX_X",\n "PURIX_Y",\n] as const;\nexport const AMBIENT_ENV = ["CI", "HOME"] as const;';
    expect(namesFromEnvModule(src).sort()).toEqual(["CI", "HOME", "PURIX_X", "PURIX_Y"]);
  });
});
describe("undocumented", () => {
  it("lists a name that is not written in backticks in the doc", () => {
    expect(undocumented(["PURIX_A", "PURIX_B"], "uses `PURIX_A` and PURIX_B plain")).toEqual(["PURIX_B"]);
  });
  it("is empty when every name is documented", () => {
    expect(undocumented(["PURIX_A"], "| `PURIX_A` | x |")).toEqual([]);
  });
});

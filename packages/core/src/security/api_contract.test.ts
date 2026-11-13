// packages/core/src/security/api_contract.test.ts
import { describe, test } from "node:test";
import { expect } from "expect";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ROUTES, API_ROUTE_PATHS } from "./api_contract";

const here = dirname(fileURLToPath(import.meta.url));

describe("api contract", () => {
  test("api_client.ts names no route path that is not in the contract", () => {
    const src = readFileSync(join(here, "api_client.ts"), "utf8");
    const quoted = [...src.matchAll(/["'`](\/[a-z][a-z0-9/_-]*)["'`]/gi)].map((m) => m[1]!);
    const unlisted = quoted.filter((p) => !API_ROUTE_PATHS.includes(p));
    expect(unlisted).toEqual([]);
  });

  test("every route has a unique path and a known method", () => {
    const paths = Object.values(API_ROUTES).map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const r of Object.values(API_ROUTES)) expect(["GET", "POST"]).toContain(r.method);
  });
});

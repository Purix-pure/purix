// packages/core/src/security/api_server_contract.test.ts
//
// The client's route table against the server's. The server lives in the private repo, which this repo's CI cannot
// see, so this test reads api_server_contract.snapshot.json: a copy of the server's route table that the private repo
// generates (its scripts/write-contract-snapshot.ts) and keeps current (its check-contract fails when the copy here is
// stale). A client route that the server does not serve, serves with another method, or does not serve under /v1 fails
// here, in this repo's own CI, instead of at the next private-repo run.
//
// Limit: this proves the two TABLES agree. Whether the server really answers each route is checked by the private
// repo's interop tests, which run the real client against the real server.
import { describe, test } from "node:test";
import { expect } from "expect";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ROUTES, type RouteSpec } from "./api_contract";

interface ServerRoute { path: string; methods: string[]; v1: boolean }
interface Snapshot { schema: number; routes: ServerRoute[] }

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(readFileSync(join(here, "api_server_contract.snapshot.json"), "utf8")) as Snapshot;

/** Every way a client route can disagree with the server's table. Empty means they agree. */
function clientRouteProblems(client: Record<string, RouteSpec>, server: readonly ServerRoute[]): string[] {
  const problems: string[] = [];
  const byPath = new Map(server.map((r) => [r.path, r]));
  for (const [name, spec] of Object.entries(client)) {
    const prefixed = spec.path.startsWith("/v1/");
    const canonical = prefixed ? spec.path.slice(3) : spec.path;
    const entry = byPath.get(canonical);
    if (!entry) { problems.push(`${name}: the server does not list ${canonical}`); continue; }
    if (!entry.methods.includes(spec.method)) problems.push(`${name}: the server accepts only ${entry.methods.join(", ")} on ${canonical}, not ${spec.method}`);
    if (prefixed && !entry.v1) problems.push(`${name}: the server does not serve ${canonical} under /v1`);
  }
  return problems;
}

describe("the client's routes against the server's route table (snapshot from the private repo)", () => {
  test("every client route is served by the server, with that method, under that prefix", () => {
    expect(snapshot.schema).toBe(1);
    expect(snapshot.routes.length).toBeGreaterThan(0);
    expect(clientRouteProblems(API_ROUTES, snapshot.routes)).toEqual([]);
  });

  test("the snapshot is well formed: unique paths, known methods", () => {
    const paths = snapshot.routes.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const r of snapshot.routes) {
      expect(r.path.startsWith("/")).toBe(true);
      expect(r.methods.length).toBeGreaterThan(0);
      for (const m of r.methods) expect(["GET", "POST"]).toContain(m);
      expect(typeof r.v1).toBe("boolean");
    }
  });

  test("the check can fail: it reports a missing path, a wrong method and a /v1 call the server does not serve", () => {
    // Its own small server table, so this test does not depend on which routes the real server has today.
    const fakeServer: ServerRoute[] = [
      { path: "/read-only", methods: ["GET"], v1: true },
      { path: "/no-prefix", methods: ["GET"], v1: false },
    ];
    const bad: Record<string, RouteSpec> = {
      ghost: { method: "POST", path: "/not-a-route", authenticated: false },
      wrongMethod: { method: "POST", path: "/read-only", authenticated: true },
      noV1: { method: "GET", path: "/v1/no-prefix", authenticated: true },
    };
    const problems = clientRouteProblems(bad, fakeServer);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/ghost.*does not list \/not-a-route/);
    expect(problems[1]).toMatch(/wrongMethod.*accepts only GET/);
    expect(problems[2]).toMatch(/noV1.*under \/v1/);
    expect(clientRouteProblems({ ok: { method: "GET", path: "/v1/read-only", authenticated: false } }, fakeServer)).toEqual([]);
  });
});

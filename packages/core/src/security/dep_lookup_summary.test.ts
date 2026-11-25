// The summary prefetchDependencyLookup hands back, which resolveVerification stores as a `dependency_lookup` event. A fake fetcher stands in
// for the network; nothing here touches it.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prefetchDependencyLookup, clearDependencyLookupCache, OSV_BATCH_URL } from "./dep_lookup.js";
import { safeRmSync } from "../platform/fs_retry.js";

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "app", dependencies: deps });

describe("dependency lookup summary", () => {
  let dir: string;
  let routes: (url: string) => Response;
  const fetcher = async (_purpose: string, url: string): Promise<Response> => routes(url);
  const run = (files: { path: string; new_content: string }[]) => prefetchDependencyLookup(files, dir, { fetch: fetcher, now: () => 1_000_000 });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-depsummary-"));
    routes = () => json({}, 500);
    clearDependencyLookupCache();
    delete process.env.PURIX_DEP_LOOKUP;
  });
  afterEach(() => {
    safeRmSync(dir);
    delete process.env.PURIX_DEP_LOOKUP;
    clearDependencyLookupCache();
  });

  test("lookup off: no summary, so no event", async () => {
    expect(await run([{ path: "package.json", new_content: pkg({ lodash: "4.17.15" }) }])).toBeUndefined();
  });

  test("a change that touches no manifest: no summary", async () => {
    process.env.PURIX_DEP_LOOKUP = "all";
    expect(await run([{ path: "src/a.ts", new_content: "export const a = 1;" }])).toBeUndefined();
  });

  test("names the packages the registry says do not exist, and counts the rest", async () => {
    process.env.PURIX_DEP_LOOKUP = "registry";
    routes = (url) => (url.endsWith("/ghostpkg") ? json({}, 404) : json({ time: { created: "2019-05-01T00:00:00.000Z" } }));
    const s = await run([{ path: "package.json", new_content: pkg({ ghostpkg: "1.0.0", realpkg: "2.0.0" }) }]);
    expect(s?.registry).toEqual({ exists: 1, missing: 1, unanswered: 0 });
    expect(s?.missing_names).toEqual([{ ecosystem: "npm", name: "ghostpkg" }]);
    expect(s?.advisories).toEqual({ pairs: 0, with_advisories: 0, unanswered: 0 });
  });

  test("a failed lookup is 'unanswered', never 'clean'", async () => {
    process.env.PURIX_DEP_LOOKUP = "all";
    routes = () => json({}, 500);
    const s = await run([{ path: "package.json", new_content: pkg({ lodash: "4.17.15" }) }]);
    expect(s?.registry.unanswered).toBe(1);
    expect(s?.registry.exists).toBe(0);
    expect(s?.advisories).toEqual({ pairs: 1, with_advisories: 0, unanswered: 1 });
  });

  test("advisories: counts pairs that have them and lists name, version and how many", async () => {
    process.env.PURIX_DEP_LOOKUP = "osv";
    routes = (url) => (url === OSV_BATCH_URL ? json({ results: [{ vulns: [{ id: "GHSA-a", modified: "2024-01-01T00:00:00Z" }, { id: "GHSA-b", modified: "2024-01-01T00:00:00Z" }] }] }) : json({}, 404));
    const s = await run([{ path: "package.json", new_content: pkg({ lodash: "4.17.15" }) }]);
    expect(s?.advisories).toEqual({ pairs: 1, with_advisories: 1, unanswered: 0 });
    expect(s?.vulnerable).toEqual([{ ecosystem: "npm", name: "lodash", version: "4.17.15", advisory_count: 2 }]);
    expect(JSON.stringify(s)).not.toContain("GHSA");
  });
});

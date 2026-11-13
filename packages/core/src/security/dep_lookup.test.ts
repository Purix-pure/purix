// F03-03 / F03-02 lookup (D-q, D-r). A fake fetcher stands in for the network; nothing here touches it. The real OSV and registry
// replies were NOT exercised (the sandbox this was written in cannot reach them): the reply shapes below come from the OSV
// documentation (querybatch returns `results` in input order, each with `vulns: [{id, modified}]` and an optional `next_page_token`)
// and from the npm registry document (`time.created`).
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prefetchDependencyLookup, cachedAdvisoryLookup, cachedRegistryLookup, dependencyGateOptions, clearDependencyLookupCache,
  depLookupMode, parseNpmrcRegistries, npmRegistryFor, isAllowedRegistryUrl, OSV_BATCH_URL,
} from "./dep_lookup.js";
import { runSecurityGate, NEW_PACKAGE_COOLDOWN_DAYS } from "../gates/security_gate.js";
import { safeRmSync } from "../platform/fs_retry.js";
import type { DepPair } from "./dep_delta.js";

interface Call {
  purpose: string;
  url: string;
  method: string;
  body?: string;
  headers?: Record<string, string>;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const pkg = (deps: Record<string, string>) => JSON.stringify({ name: "app", dependencies: deps });

describe("PURIX_DEP_LOOKUP", () => {
  let dir: string;
  let calls: Call[];
  let routes: (call: Call) => Response | Promise<Response>;
  const fetcher = async (purpose: string, url: string, init: RequestInit = {}): Promise<Response> => {
    const c: Call = { purpose, url, method: (init.method ?? "GET").toUpperCase(), body: typeof init.body === "string" ? init.body : undefined, headers: init.headers as Record<string, string> };
    calls.push(c);
    return routes(c);
  };
  const run = (files: { path: string; new_content: string }[]) => prefetchDependencyLookup(files, dir, { fetch: fetcher, now: () => 1_000_000 });
  const exact = (name: string, version: string): DepPair => ({ ecosystem: "npm", name, spec: version, version });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-deplookup-"));
    calls = [];
    routes = () => json({}, 500);
    clearDependencyLookupCache();
    delete process.env.PURIX_DEP_LOOKUP;
  });
  afterEach(() => {
    safeRmSync(dir);
    delete process.env.PURIX_DEP_LOOKUP;
    clearDependencyLookupCache();
  });

  test("off by default: no request, and the gate gets no options at all", async () => {
    await run([{ path: "package.json", new_content: pkg({ lodash: "4.17.15" }) }]);
    expect(calls).toHaveLength(0);
    expect(dependencyGateOptions()).toEqual({});
    expect(depLookupMode()).toEqual({ osv: false, registry: false });
  });

  test("mode values", () => {
    for (const [v, want] of [["osv", { osv: true, registry: false }], ["registry", { osv: false, registry: true }], ["all", { osv: true, registry: true }], ["1", { osv: true, registry: true }], ["osv,registry", { osv: true, registry: true }], ["nonsense", { osv: false, registry: false }]] as const) {
      process.env.PURIX_DEP_LOOKUP = v;
      expect(depLookupMode()).toEqual(want);
    }
  });

  test("OSV: one batch POST to the fixed host carrying only name, ecosystem and exact version", async () => {
    process.env.PURIX_DEP_LOOKUP = "osv";
    routes = (c) => (c.url === OSV_BATCH_URL ? json({ results: [{ vulns: [{ id: "GHSA-p6mc-m468-83gw", modified: "2024-01-01T00:00:00Z" }] }] }) : json({}, 404));
    await run([{ path: "package.json", new_content: pkg({ lodash: "4.17.15" }) }]);
    const osv = calls.filter((c) => c.url === OSV_BATCH_URL);
    expect(osv).toHaveLength(1);
    expect(osv[0]!.purpose).toBe("dependency-lookup");
    expect(osv[0]!.method).toBe("POST");
    expect(JSON.parse(osv[0]!.body!)).toEqual({ queries: [{ package: { name: "lodash", ecosystem: "npm" }, version: "4.17.15" }] });
    // nothing else about the project is in the body
    expect(osv[0]!.body).not.toContain("app");
    expect(cachedAdvisoryLookup([exact("lodash", "4.17.15")], 1_000_000)).toEqual([{ ecosystem: "npm", name: "lodash", version: "4.17.15", ids: ["GHSA-p6mc-m468-83gw"] }]);
  });

  test("OSV: a range is not sent (it names no version), and a pair with no answer makes the whole answer 'not checked'", async () => {
    process.env.PURIX_DEP_LOOKUP = "osv";
    routes = () => json({ results: [{}] });
    await run([{ path: "package.json", new_content: pkg({ lodash: "4.17.15", axios: "^1.6.0" }) }]);
    const sent = JSON.parse(calls[0]!.body!).queries;
    expect(sent).toHaveLength(1);
    expect(cachedAdvisoryLookup([exact("lodash", "4.17.15")], 1_000_000)).toEqual([{ ecosystem: "npm", name: "lodash", version: "4.17.15", ids: [] }]);
    // asking for a pair that was never looked up: undefined, never a partial list
    expect(cachedAdvisoryLookup([exact("lodash", "4.17.15"), exact("other", "1.0.0")], 1_000_000)).toBeUndefined();
  });

  test("OSV: a reply that cannot be matched to the questions is not used", async () => {
    process.env.PURIX_DEP_LOOKUP = "osv";
    routes = () => json({ results: [{}, {}, {}] }); // 3 answers for 1 question
    await run([{ path: "package.json", new_content: pkg({ lodash: "4.17.15" }) }]);
    expect(cachedAdvisoryLookup([exact("lodash", "4.17.15")], 1_000_000)).toBeUndefined();
  });

  test("OSV: HTTP 500, a thrown network error and malformed JSON cache nothing and never throw", async () => {
    process.env.PURIX_DEP_LOOKUP = "osv";
    for (const r of [() => json({}, 500), () => { throw new Error("offline"); }, () => new Response("<html>", { status: 200 })]) {
      routes = r;
      clearDependencyLookupCache();
      await run([{ path: "package.json", new_content: pkg({ lodash: "4.17.15" }) }]);
      expect(cachedAdvisoryLookup([exact("lodash", "4.17.15")], 1_000_000)).toBeUndefined();
    }
  });

  test("OSV: a next_page_token is followed for that query only", async () => {
    process.env.PURIX_DEP_LOOKUP = "osv";
    let n = 0;
    routes = (c) => {
      n++;
      const q = JSON.parse(c.body!).queries as { page_token?: string }[];
      if (n === 1) return json({ results: [{ vulns: [{ id: "A-1" }], next_page_token: "t1" }, { vulns: [] }] });
      expect(q).toHaveLength(1);
      expect(q[0]!.page_token).toBe("t1");
      return json({ results: [{ vulns: [{ id: "A-2" }] }] });
    };
    await run([{ path: "package.json", new_content: pkg({ a: "1.0.0", b: "2.0.0" }) }]);
    expect(cachedAdvisoryLookup([exact("a", "1.0.0")], 1_000_000)![0]!.ids).toEqual(["A-1", "A-2"]);
    expect(cachedAdvisoryLookup([exact("b", "2.0.0")], 1_000_000)![0]!.ids).toEqual([]);
  });

  test("an unchanged dependency is not looked up again: only what the change adds is sent", async () => {
    process.env.PURIX_DEP_LOOKUP = "osv";
    writeFileSync(join(dir, "package.json"), pkg({ lodash: "4.17.15" }));
    routes = () => json({ results: [{}] });
    await run([{ path: "package.json", new_content: pkg({ lodash: "4.17.15", chalk: "5.3.0" }) }]);
    expect(JSON.parse(calls[0]!.body!).queries).toEqual([{ package: { name: "chalk", ecosystem: "npm" }, version: "5.3.0" }]);
  });

  test("a second run inside the cache window sends nothing", async () => {
    process.env.PURIX_DEP_LOOKUP = "osv";
    routes = () => json({ results: [{}] });
    const files = [{ path: "package.json", new_content: pkg({ lodash: "4.17.15" }) }];
    await run(files);
    await run(files);
    expect(calls).toHaveLength(1);
  });

  test("registry: 404 is 'missing', 200 gives the first-publish date, 500 gives no verdict", async () => {
    process.env.PURIX_DEP_LOOKUP = "registry";
    routes = (c) => {
      if (c.url.endsWith("/ghostpkg")) return json({ error: "Not found" }, 404);
      if (c.url.endsWith("/realpkg")) return json({ time: { created: "2019-05-01T00:00:00.000Z", modified: "2024-01-01T00:00:00.000Z" } });
      return json({}, 503);
    };
    await run([{ path: "package.json", new_content: pkg({ ghostpkg: "^1.0.0", realpkg: "^2.0.0", flaky: "^3.0.0" }) }]);
    expect(calls.every((c) => c.purpose === "dependency-lookup" && c.method === "GET")).toBe(true);
    expect(calls.map((c) => c.url).sort()).toEqual(["https://registry.npmjs.org/flaky", "https://registry.npmjs.org/ghostpkg", "https://registry.npmjs.org/realpkg"]);
    const got = cachedRegistryLookup([exact("ghostpkg", "^1"), exact("realpkg", "^2"), exact("flaky", "^3")].map((p) => ({ ...p, version: undefined })), 1_000_000);
    expect(got.find((v) => v.name === "ghostpkg")?.state).toBe("missing");
    expect(got.find((v) => v.name === "realpkg")?.created).toBe("2019-05-01T00:00:00.000Z");
    expect(got.find((v) => v.name === "flaky")).toBeUndefined();
  });

  test("registry: a scoped name is asked as @scope%2fname", async () => {
    process.env.PURIX_DEP_LOOKUP = "registry";
    routes = () => json({}, 404);
    await run([{ path: "package.json", new_content: pkg({ "@types/node": "^22.0.0" }) }]);
    expect(calls[0]!.url).toBe("https://registry.npmjs.org/@types%2fnode");
  });

  test("registry: PyPI names from requirements.txt go to pypi.org and the earliest upload is the first-publish date", async () => {
    process.env.PURIX_DEP_LOOKUP = "registry";
    routes = () => json({ releases: { "1.0": [{ upload_time_iso_8601: "2020-02-02T00:00:00Z" }], "0.9": [{ upload_time_iso_8601: "2019-01-01T00:00:00Z" }] } });
    await run([{ path: "requirements.txt", new_content: "requests==2.31.0\n" }]);
    expect(calls[0]!.url).toBe("https://pypi.org/pypi/requests/json");
    const v = cachedRegistryLookup([{ ecosystem: "PyPI", name: "requests", spec: "==2.31.0", version: "2.31.0" }], 1_000_000);
    expect(v[0]!.created).toBe("2019-01-01T00:00:00.000Z");
  });

  test("a git, URL or path dependency is never asked about at a registry", async () => {
    process.env.PURIX_DEP_LOOKUP = "all";
    routes = () => json({ results: [{}] });
    await run([{ path: "package.json", new_content: pkg({ a: "github:owner/repo", b: "https://example.com/b.tgz", c: "file:../c", d: "owner/repo", e: "workspace:*" }) }]);
    expect(calls).toHaveLength(0);
  });

  test("private registries: the project's registry is asked, and the name is NEVER sent to OSV", async () => {
    process.env.PURIX_DEP_LOOKUP = "all";
    writeFileSync(join(dir, ".npmrc"), "registry=https://artifactory.corp.example/api/npm/npm/\n@corp:registry=https://npm.corp.example\n");
    routes = (c) => (c.url === OSV_BATCH_URL ? json({ results: [{}] }) : json({ time: { created: "2018-01-01T00:00:00Z" } }));
    await run([{ path: "package.json", new_content: pkg({ "@corp/secret-tool": "1.2.3", leftpad: "1.0.0" }) }]);
    const urls = calls.map((c) => c.url);
    expect(urls).toContain("https://npm.corp.example/@corp%2fsecret-tool");
    expect(urls).toContain("https://artifactory.corp.example/api/npm/npm/leftpad");
    expect(urls).not.toContain(OSV_BATCH_URL); // both names resolve to a private registry
    expect(calls.some((c) => (c.body ?? "").includes("secret-tool"))).toBe(false);
  });

  test("a registry address in the repository that could reach an internal service is not used", () => {
    expect(isAllowedRegistryUrl("https://registry.npmjs.org")).toBe(true);
    expect(isAllowedRegistryUrl("http://registry.example.com")).toBe(false);
    expect(isAllowedRegistryUrl("https://169.254.169.254/latest")).toBe(false);
    expect(isAllowedRegistryUrl("https://127.0.0.1:4873")).toBe(false);
    expect(isAllowedRegistryUrl("https://10.1.2.3")).toBe(false);
    expect(isAllowedRegistryUrl("https://localhost:4873")).toBe(false);
    expect(isAllowedRegistryUrl("https://[::1]/")).toBe(false);
    expect(isAllowedRegistryUrl("https://user:pw@registry.example.com")).toBe(false);
    const rc = parseNpmrcRegistries("registry=http://169.254.169.254/\n");
    expect(npmRegistryFor("x", rc).url).toBeUndefined();
    expect(npmRegistryFor("x", parseNpmrcRegistries("")).url).toBe("https://registry.npmjs.org");
    expect(parseNpmrcRegistries("registry=${NPM_REGISTRY}\n").registry).toBeUndefined();
  });

  test("a malicious .npmrc pointing at an internal address causes no request at all", async () => {
    process.env.PURIX_DEP_LOOKUP = "all";
    writeFileSync(join(dir, ".npmrc"), "registry=https://169.254.169.254/\n");
    routes = () => json({ results: [{}] });
    await run([{ path: "package.json", new_content: pkg({ lodash: "4.17.15" }) }]);
    expect(calls).toHaveLength(0);
  });
});

describe("the gate with the lookup on", () => {
  const NOW = Date.parse("2026-11-12T12:00:00Z");
  const file = (deps: Record<string, string>) => [{ path: "package.json", content: pkg(deps) }];
  const verdict = (name: string, state: "exists" | "missing", created?: string) => ({ ecosystem: "npm" as const, name, state, host: "registry.npmjs.org", ...(created ? { created } : {}) });

  test("a name the registry does not have is reported, not blocked", () => {
    const r = runSecurityGate(file({ "totally-made-up-pkg": "^1.0.0" }), undefined, { registryLookup: () => [verdict("totally-made-up-pkg", "missing")], now: () => NOW });
    const f = r.findings.find((x) => x.category === "Dependency Not Found");
    expect(f?.severity).toBe("Medium");
    expect(f?.message).toContain("totally-made-up-pkg");
    expect(f?.message).toContain("registry.npmjs.org");
    expect(r.blocked).toBe(false);
  });

  test("first published inside the cooldown is reported; the day before the boundary and after it are not", () => {
    const day = 24 * 3600 * 1000;
    const created = (daysAgo: number) => new Date(NOW - daysAgo * day).toISOString();
    const at = (daysAgo: number) => runSecurityGate(file({ fresh: "^1.0.0" }), undefined, { registryLookup: () => [verdict("fresh", "exists", created(daysAgo))], now: () => NOW });
    expect(at(2).findings.some((x) => x.category === "New Package" && x.message.includes("2 days ago"))).toBe(true);
    expect(at(0.2).findings.find((x) => x.category === "New Package")?.message).toContain("less than a day");
    expect(at(NEW_PACKAGE_COOLDOWN_DAYS - 0.1).findings.some((x) => x.category === "New Package")).toBe(true);
    expect(at(NEW_PACKAGE_COOLDOWN_DAYS + 0.1).findings.some((x) => x.category === "New Package")).toBe(false);
    expect(at(2).blocked).toBe(false);
  });

  test("an old package that exists adds no finding", () => {
    const r = runSecurityGate(file({ lodash: "^4.17.21" }), undefined, { registryLookup: () => [verdict("lodash", "exists", "2012-01-01T00:00:00Z")], now: () => NOW });
    expect(r.findings.filter((x) => ["Dependency Not Found", "New Package"].includes(x.category))).toHaveLength(0);
  });

  test("a name the lookup could not answer for is listed as not checked", () => {
    const r = runSecurityGate(file({ mystery: "^1.0.0" }), undefined, { registryLookup: () => [], now: () => NOW });
    const f = r.findings.find((x) => x.category === "Dependency Check" && x.message.includes("exist"));
    expect(f?.message).toContain("mystery");
    expect(f?.message).toContain("not checked");
  });

  test("a registry source that throws is 'not checked', never a pass", () => {
    const r = runSecurityGate(file({ mystery: "^1.0.0" }), undefined, { registryLookup: () => { throw new Error("boom"); }, now: () => NOW });
    expect(r.findings.some((x) => x.message.includes("was not checked") || x.message.includes("not checked"))).toBe(true);
  });

  test("with no registry source the gate says nothing about existence (the default, unchanged)", () => {
    const r = runSecurityGate(file({ mystery: "^1.0.0" }));
    expect(r.findings.some((x) => x.category === "Dependency Not Found" || x.category === "New Package")).toBe(false);
    expect(r.findings.some((x) => x.message.includes("exist"))).toBe(false);
  });

  test("a git dependency gets no existence question", () => {
    const calls: DepPair[][] = [];
    runSecurityGate(file({ viagit: "github:owner/repo" }), undefined, { registryLookup: (p) => { calls.push(p); return []; }, now: () => NOW });
    expect(calls.flat().some((p) => p.name === "viagit")).toBe(false);
  });

  test("D-r: an ordinary advisory is reported and does not block", () => {
    const r = runSecurityGate(file({ lodash: "4.17.15" }), undefined, { advisoryLookup: (pairs) => pairs.map((p) => ({ ecosystem: p.ecosystem, name: p.name, version: p.version!, ids: ["GHSA-aaaa-bbbb-cccc", "CVE-2021-23337"] })) });
    const f = r.findings.find((x) => x.category === "Known Vulnerability");
    expect(f?.message).toContain("GHSA-aaaa-bbbb-cccc");
    expect(f?.severity).toBe("Medium");
    expect(r.blocked).toBe(false);
  });

  test("D-r: a malicious-package record (MAL- id) blocks, and an ordinary advisory next to it is still listed", () => {
    const r = runSecurityGate(file({ evil: "1.0.0" }), undefined, { advisoryLookup: (pairs) => pairs.map((p) => ({ ecosystem: p.ecosystem, name: p.name, version: p.version!, ids: ["MAL-2025-190585", "GHSA-xxxx-yyyy-zzzz"] })) });
    expect(r.blocked).toBe(true);
    expect(r.findings.find((x) => x.category === "Malicious Package")?.severity).toBe("High");
    expect(r.findings.find((x) => x.category === "Malicious Package")?.message).toContain("MAL-2025-190585");
    expect(r.findings.find((x) => x.category === "Known Vulnerability")?.message).not.toContain("MAL-");
  });

  test("an advisory-free answer from the source is not reported as a finding, and the pair is not 'not checked' either", () => {
    const r = runSecurityGate(file({ lodash: "4.17.21" }), undefined, { advisoryLookup: (pairs) => pairs.map((p) => ({ ecosystem: p.ecosystem, name: p.name, version: p.version!, ids: [] })) });
    expect(r.findings.some((x) => x.category === "Known Vulnerability")).toBe(false);
    expect(r.findings.some((x) => x.message.includes("not checked for known vulnerabilities"))).toBe(false);
  });
});

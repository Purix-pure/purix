// packages/core/src/security/api_client_refresh.test.ts
//
// Per-device sessions on the client (FR-07): login sends device info and asks for a refresh
// token, and a 401 on an authenticated call is repaired once with that token.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./session";
import { createApiClient, LoginRequiredError, shouldRefreshAhead, REFRESH_AHEAD_MS, MIN_REFRESH_GAP_MS } from "./api_client";

let dir: string;
let store: ReturnType<typeof createSessionStore>;
let client: ReturnType<typeof createApiClient>;
const originalFetch = globalThis.fetch;

type Call = { url: string; auth?: string; body?: Record<string, unknown> };
let calls: Call[];

function record(url: string, init?: RequestInit): Call {
  const call: Call = {
    url: new URL(url).pathname,
    auth: (init?.headers as Record<string, string> | undefined)?.authorization,
    body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
  };
  calls.push(call);
  return call;
}

const entitlements = () => new Response(JSON.stringify({ tier: "pro", flags: {}, cacheTtlSeconds: 900 }), { status: 200 });
const expired = () => new Response(JSON.stringify({ error: "Not logged in." }), { status: 401 });
const refreshed = (token: string, refreshToken: string) =>
  new Response(JSON.stringify({ token, refreshToken, expiresAt: "2026-10-11T12:15:00.000Z", refreshExpiresAt: "2026-11-10T12:00:00.000Z", sessionId: "s1" }), { status: 200 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-refresh-test-"));
  store = createSessionStore(dir);
  client = createApiClient(store.loadSession, store.saveSession);
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe("session store", () => {
  test("keeps refresh fields when given, and none for a legacy login", () => {
    store.saveSession("t1", "a@b.co");
    expect(store.loadSession()!.refreshToken).toBeUndefined();
    store.saveSession("t2", "a@b.co", { refreshToken: "prx_1", expiresAt: "e", refreshExpiresAt: "r", sessionId: "s" });
    const s = store.loadSession()!;
    expect([s.token, s.refreshToken, s.expiresAt, s.refreshExpiresAt, s.sessionId]).toEqual(["t2", "prx_1", "e", "r", "s"]);
  });
});

describe("verifyCode", () => {
  test("asks for refresh and names the device when a device is given", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      record(url, init);
      return new Response(JSON.stringify({ token: "a", refreshToken: "prx_x" }), { status: 200 });
    }) as typeof fetch;
    const res = await client.verifyCode("a@b.co", "123456", { deviceId: "machine-1", deviceName: "laptop" });
    expect(calls[0]!.body).toEqual({ email: "a@b.co", code: "123456", supportsRefresh: true, deviceId: "machine-1", deviceName: "laptop" });
    expect(res.refreshToken).toBe("prx_x");
  });

  test("sends the old body shape when no device is given", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      record(url, init);
      return new Response(JSON.stringify({ token: "a" }), { status: 200 });
    }) as typeof fetch;
    await client.verifyCode("a@b.co", "123456");
    expect(calls[0]!.body).toEqual({ email: "a@b.co", code: "123456" });
  });
});

describe("refresh on 401", () => {
  test("renews once, saves the new pair, repeats the call with the new token", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old", sessionId: "s1" });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      if (c.url === "/auth/refresh") return refreshed("new", "prx_new");
      return c.auth === "Bearer new" ? entitlements() : expired();
    }) as typeof fetch;

    const res = await client.getEntitlements();
    expect(res.tier).toBe("pro");
    expect(calls.map((c) => c.url)).toEqual(["/entitlements", "/auth/refresh", "/entitlements"]);
    expect(calls[1]!.body).toEqual({ refreshToken: "prx_old" });
    expect(calls[1]!.auth).toBeUndefined();
    const saved = store.loadSession()!;
    expect([saved.token, saved.refreshToken, saved.email]).toEqual(["new", "prx_new", "a@b.co"]);
  });

  test("a refresh the server refuses ends in the original login-required error and keeps the stored session", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old" });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      return c.url === "/auth/refresh" ? new Response(JSON.stringify({ error: "This session was ended." }), { status: 401 }) : expired();
    }) as typeof fetch;

    await expect(client.getEntitlements()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(calls.filter((c) => c.url === "/auth/refresh").length).toBe(1);
  });

  test("never loops: a renewed token that is still refused fails after one refresh", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old" });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      return c.url === "/auth/refresh" ? refreshed("new", "prx_new") : expired();
    }) as typeof fetch;

    await expect(client.getEntitlements()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(calls.map((c) => c.url)).toEqual(["/entitlements", "/auth/refresh", "/entitlements"]);
  });

  test("a legacy session (no refresh token) never calls refresh", async () => {
    store.saveSession("old", "a@b.co");
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      record(url, init);
      return expired();
    }) as typeof fetch;
    await expect(client.getEntitlements()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(calls.map((c) => c.url)).toEqual(["/entitlements"]);
  });

  test("a network failure during refresh keeps the refresh token for the next run", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old" });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      if (c.url === "/auth/refresh") throw new Error("ECONNRESET");
      return expired();
    }) as typeof fetch;

    await expect(client.getEntitlements()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(store.loadSession()!.refreshToken).toBe("prx_old");
  });

  test("a 409 means another process just refreshed: the newer saved session is used", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old" });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      if (c.url === "/auth/refresh") {
        store.saveSession("sibling", "a@b.co", { refreshToken: "prx_sibling" });
        return new Response(JSON.stringify({ error: "just used" }), { status: 409 });
      }
      return c.auth === "Bearer sibling" ? entitlements() : expired();
    }) as typeof fetch;

    const res = await client.getEntitlements();
    expect(res.tier).toBe("pro");
  });

  test("two calls that both hit 401 at once share one refresh, because the token is single-use", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old" });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      if (c.url === "/auth/refresh") {
        await new Promise((r) => setTimeout(r, 20));
        return refreshed("new", "prx_new");
      }
      return c.auth === "Bearer new" ? entitlements() : expired();
    }) as typeof fetch;

    const [a, b] = await Promise.all([client.getEntitlements(), client.getEntitlements()]);
    expect([a.tier, b.tier]).toEqual(["pro", "pro"]);
    expect(calls.filter((c) => c.url === "/auth/refresh").length).toBe(1);
  });
});

// C-42: renew from `expiresAt` before the call, so an expiring token does not cost a failed round trip.
describe("refresh ahead of expiry", () => {
  const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
  const longAgo = () => new Date(Date.now() - 10 * 60_000).toISOString();
  const renewedOk = (token: string, refreshToken: string) =>
    new Response(JSON.stringify({ token, refreshToken, expiresAt: inMs(15 * 60_000), refreshExpiresAt: inMs(30 * 24 * 3600_000), sessionId: "s1" }), { status: 200 });

  /** A client whose stored "old" session looks like it was issued ten minutes ago (saveSession stamps "now"). */
  function agedClient() {
    const load = () => {
      const s = store.loadSession();
      return s && s.token === "old" ? { ...s, issuedAt: longAgo() } : s;
    };
    return createApiClient(load, store.saveSession);
  }

  test("an expiring token is renewed first: no failed call, one refresh, one real call", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old", expiresAt: inMs(20_000), refreshExpiresAt: inMs(24 * 3600_000), sessionId: "s1" });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      if (c.url === "/auth/refresh") return renewedOk("new", "prx_new");
      return c.auth === "Bearer new" ? entitlements() : expired();
    }) as typeof fetch;

    const res = await agedClient().getEntitlements();
    expect(res.tier).toBe("pro");
    expect(calls.map((c) => c.url)).toEqual(["/auth/refresh", "/entitlements"]);
    expect(calls[0]!.body).toEqual({ refreshToken: "prx_old" });
    expect(calls[1]!.auth).toBe("Bearer new");
    expect(store.loadSession()!.refreshToken).toBe("prx_new");
  });

  test("a token with plenty of life left is used as is, and the next call does not refresh either", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old", expiresAt: inMs(10 * 60_000) });
    globalThis.fetch = (async (url: string, init?: RequestInit) => { record(url, init); return entitlements(); }) as typeof fetch;
    const c = agedClient();
    await c.getEntitlements();
    await c.getEntitlements();
    expect(calls.map((x) => x.url)).toEqual(["/entitlements", "/entitlements"]);
  });

  test("after a renewal ahead, later calls use the new token with no further refresh", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old", expiresAt: inMs(5_000) });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      if (c.url === "/auth/refresh") return renewedOk("new", "prx_new");
      return c.auth === "Bearer new" ? entitlements() : expired();
    }) as typeof fetch;
    const c = agedClient();
    await c.getEntitlements();
    await c.getEntitlements();
    expect(calls.map((x) => x.url)).toEqual(["/auth/refresh", "/entitlements", "/entitlements"]);
  });

  test("a refresh the server refuses ahead of time is not sent a second time when the call then gets 401", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old", expiresAt: inMs(5_000) });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      return c.url === "/auth/refresh" ? new Response(JSON.stringify({ error: "ended" }), { status: 401 }) : expired();
    }) as typeof fetch;
    await expect(agedClient().getEntitlements()).rejects.toBeInstanceOf(LoginRequiredError);
    expect(calls.map((x) => x.url)).toEqual(["/auth/refresh", "/entitlements"]);
  });

  test("if the renewal fails but the old token still works, the call succeeds", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old", expiresAt: inMs(5_000) });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      if (c.url === "/auth/refresh") throw new Error("ECONNRESET");
      return entitlements();
    }) as typeof fetch;
    const res = await agedClient().getEntitlements();
    expect(res.tier).toBe("pro");
    expect(store.loadSession()!.refreshToken).toBe("prx_old"); // kept for the next run
  });

  test("a token just issued is not renewed again even if its expiry looks past (a fast clock cannot cause a refresh storm)", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old", expiresAt: inMs(-5 * 60_000) }); // issuedAt = now
    globalThis.fetch = (async (url: string, init?: RequestInit) => { record(url, init); return entitlements(); }) as typeof fetch;
    await client.getEntitlements();
    expect(calls.map((x) => x.url)).toEqual(["/entitlements"]);
  });

  test("two calls that both find the token expiring share one refresh", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old", expiresAt: inMs(5_000) });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const c = record(url, init);
      if (c.url === "/auth/refresh") { await new Promise((r) => setTimeout(r, 20)); return renewedOk("new", "prx_new"); }
      return c.auth === "Bearer new" ? entitlements() : expired();
    }) as typeof fetch;
    const c = agedClient();
    const [a, b] = await Promise.all([c.getEntitlements(), c.getEntitlements()]);
    expect([a.tier, b.tier]).toEqual(["pro", "pro"]);
    expect(calls.filter((x) => x.url === "/auth/refresh").length).toBe(1);
  });

  test("a legacy session (no refresh token, no expiry) is never renewed ahead", async () => {
    store.saveSession("old", "a@b.co");
    globalThis.fetch = (async (url: string, init?: RequestInit) => { record(url, init); return entitlements(); }) as typeof fetch;
    await agedClient().getEntitlements();
    expect(calls.map((x) => x.url)).toEqual(["/entitlements"]);
  });

  test("an unauthenticated route never refreshes", async () => {
    store.saveSession("old", "a@b.co", { refreshToken: "prx_old", expiresAt: inMs(5_000) });
    globalThis.fetch = (async (url: string, init?: RequestInit) => { record(url, init); return new Response("{}", { status: 200 }); }) as typeof fetch;
    await agedClient().requestCode("a@b.co");
    expect(calls.map((x) => x.url)).toEqual(["/auth/request-code"]);
  });
});

describe("shouldRefreshAhead", () => {
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const base = { token: "t", email: "a@b.co", issuedAt: iso(-10 * 60_000), refreshToken: "r", expiresAt: iso(30_000), refreshExpiresAt: iso(86_400_000) };

  test("boundaries", () => {
    expect(shouldRefreshAhead(base, now)).toBe(true);
    expect(shouldRefreshAhead({ ...base, expiresAt: iso(REFRESH_AHEAD_MS) }, now)).toBe(true);
    expect(shouldRefreshAhead({ ...base, expiresAt: iso(REFRESH_AHEAD_MS + 1) }, now)).toBe(false);
    expect(shouldRefreshAhead({ ...base, expiresAt: iso(-1000) }, now)).toBe(true); // already expired
    expect(shouldRefreshAhead({ ...base, issuedAt: iso(-(MIN_REFRESH_GAP_MS - 1)) }, now)).toBe(false);
    expect(shouldRefreshAhead({ ...base, issuedAt: iso(-MIN_REFRESH_GAP_MS) }, now)).toBe(true);
  });
  test("missing or unreadable fields mean no renewal ahead", () => {
    expect(shouldRefreshAhead({ ...base, refreshToken: undefined }, now)).toBe(false);
    expect(shouldRefreshAhead({ ...base, expiresAt: undefined }, now)).toBe(false);
    expect(shouldRefreshAhead({ ...base, expiresAt: "not a date" }, now)).toBe(false);
    expect(shouldRefreshAhead({ ...base, refreshExpiresAt: iso(-1) }, now)).toBe(false); // refresh token itself expired
    expect(shouldRefreshAhead({ ...base, refreshExpiresAt: "garbage" }, now)).toBe(true); // unreadable: try anyway
  });
});

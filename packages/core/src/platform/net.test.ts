// PURIX-21 G8 / D11(c): the network door refuses unsafe requests, reports only host and purpose to
// observers, and calls the current globalThis.fetch so tests can stub it.
import { afterEach, describe, it } from "node:test";
import { expect } from "expect";
import { checkEgress, EgressRefusedError, isLocalOrPrivateHost, netFetch, onEgress, type EgressEvent } from "./net";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("isLocalOrPrivateHost", () => {
  it("accepts loopback and private-network hosts", () => {
    for (const h of ["localhost", "foo.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.5", "[::1]", "::1", "fd12::1", "fe80::1", "100.64.0.1", "100.127.255.1", "host.docker.internal", "ollama", "gpu-box.local", "llm.internal", "box.lan", "nas.home.arpa"]) {
      expect(isLocalOrPrivateHost(h)).toBe(true);
    }
  });
  it("rejects public hosts, including near-misses", () => {
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "11.0.0.1", "2001:db8::1", "localhost.example.com", "100.63.0.1", "100.128.0.1", "local.example.com", "example.internal.com"]) {
      expect(isLocalOrPrivateHost(h)).toBe(false);
    }
  });
});

describe("checkEgress", () => {
  it("allows https anywhere and http to local hosts", () => {
    expect(checkEgress("llm-provider", "https://api.example.com/v1").host).toBe("api.example.com");
    expect(checkEgress("llm-provider", "http://localhost:11434/v1").host).toBe("localhost:11434");
    expect(checkEgress("webhook", "http://192.168.1.9/hook").hostname).toBe("192.168.1.9");
  });
  it("refuses plain http to a public host", () => {
    expect(() => checkEgress("llm-provider", "http://api.example.com/v1")).toThrow(EgressRefusedError);
    expect(() => checkEgress("llm-provider", "http://api.example.com/v1")).toThrow(/unencrypted/);
  });
  it("refuses other schemes, credentials in the URL, bad URLs and unknown purposes", () => {
    expect(() => checkEgress("webhook", "file:///etc/passwd")).toThrow(/scheme/);
    expect(() => checkEgress("webhook", "ftp://example.com/x")).toThrow(/scheme/);
    expect(() => checkEgress("webhook", "https://user:pw@example.com/x")).toThrow(/user name or password/);
    expect(() => checkEgress("webhook", "not a url")).toThrow(/not a valid URL/);
    expect(() => checkEgress("telemetry" as never, "https://example.com")).toThrow(/unknown purpose/);
  });
});

describe("netFetch", () => {
  it("calls the current globalThis.fetch with a timeout signal when the caller gave none", async () => {
    let seen: RequestInit | undefined;
    let seenUrl = "";
    globalThis.fetch = (async (u: string, init?: RequestInit) => {
      seenUrl = u;
      seen = init;
      return new Response("ok");
    }) as typeof fetch;
    const res = await netFetch("purix-api", "https://api.purix.dev/entitlements", { method: "GET" });
    expect(await res.text()).toBe("ok");
    expect(seenUrl).toBe("https://api.purix.dev/entitlements");
    expect(seen?.signal).toBeDefined();
  });

  it("keeps the caller's own signal", async () => {
    const mine = new AbortController().signal;
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      seen = init;
      return new Response("ok");
    }) as typeof fetch;
    await netFetch("webhook", "https://example.com/h", { signal: mine });
    expect(seen?.signal).toBe(mine);
  });

  it("does not call fetch when the request is refused", async () => {
    let called = false;
    globalThis.fetch = () => {
      called = true;
      return Promise.resolve(new Response("x"));
    };
    await expect(netFetch("llm-provider", "http://api.example.com/v1")).rejects.toBeInstanceOf(EgressRefusedError);
    expect(called).toBe(false);
  });

  it("tells observers the host, purpose and method, and nothing that could carry a key or a prompt", async () => {
    globalThis.fetch = () => Promise.resolve(new Response("ok"));
    const events: EgressEvent[] = [];
    const off = onEgress((e) => events.push(e));
    await netFetch("llm-provider", "https://api.anthropic.com/v1/messages", {
      method: "post",
      headers: { "x-api-key": "SECRET-KEY" },
      body: "SECRET-PROMPT",
    });
    off();
    expect(events).toEqual([{ purpose: "llm-provider", method: "POST", host: "api.anthropic.com", protocol: "https:" }]);
    expect(JSON.stringify(events)).not.toMatch(/SECRET/);
  });

  it("survives an observer that throws, and stops notifying a removed observer", async () => {
    globalThis.fetch = () => Promise.resolve(new Response("ok"));
    let n = 0;
    const offBad = onEgress(() => {
      throw new Error("boom");
    });
    const off = onEgress(() => void n++);
    await netFetch("webhook", "https://example.com/h");
    off();
    offBad();
    await netFetch("webhook", "https://example.com/h");
    expect(n).toBe(1);
  });
});

describe("netFetch redirects", () => {
  const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });

  it("refuses a redirect to another host and never sends the second request", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (u: string) => {
      calls.push(u);
      return redirect(302, "https://evil.example.net/steal");
    }) as typeof fetch;
    await expect(netFetch("llm-provider", "https://api.example.com/v1", { method: "GET" })).rejects.toBeInstanceOf(EgressRefusedError);
    expect(calls).toEqual(["https://api.example.com/v1"]);
  });

  it("refuses a redirect from https down to http", async () => {
    globalThis.fetch = (async () => redirect(301, "http://api.example.com/v1"));
    await expect(netFetch("webhook", "https://api.example.com/hook", { method: "GET" })).rejects.toBeInstanceOf(EgressRefusedError);
  });

  it("follows a same-origin redirect for GET and tells fetch not to follow by itself", async () => {
    const seen: (RequestInit | undefined)[] = [];
    let n = 0;
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      seen.push(init);
      return n++ === 0 ? redirect(301, "/v2/items") : new Response("done");
    }) as typeof fetch;
    const res = await netFetch("purix-api", "https://api.purix.dev/items", { method: "GET" });
    expect(await res.text()).toBe("done");
    expect(seen.every((i) => i?.redirect === "manual")).toBe(true);
  });

  it("does not re-send a POST body after a 302, and returns the 302 to the caller", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return redirect(302, "/elsewhere");
    });
    const res = await netFetch("llm-provider", "https://api.example.com/v1", { method: "POST", body: "prompt" });
    expect(res.status).toBe(302);
    expect(calls).toBe(1);
  });

  it("follows a same-origin 307 for POST (method and body are kept)", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      bodies.push(init?.body);
      return bodies.length === 1 ? redirect(307, "/v1/again") : new Response("ok");
    }) as typeof fetch;
    const res = await netFetch("llm-provider", "https://api.example.com/v1", { method: "POST", body: "prompt" });
    expect(await res.text()).toBe("ok");
    expect(bodies).toEqual(["prompt", "prompt"]);
  });

  it("stops after three same-origin redirects", async () => {
    globalThis.fetch = (async () => redirect(302, "/loop"));
    await expect(netFetch("webhook", "https://api.example.com/a", { method: "GET" })).rejects.toBeInstanceOf(EgressRefusedError);
  });
});

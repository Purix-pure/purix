// packages/core/src/security/api_client.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./session";
import { createApiClient, ApiUnreachableError, ApiRequestError } from "./api_client";

// Every test builds its own session store bound to a throwaway directory
// and its own apiClient wired to that store's loadSession — this repo's
// real machine-global ~/.purix/session.enc is never touched, and (unlike
// an earlier draft of this file) it doesn't rely on redirecting HOME,
// which Bun's os.homedir() doesn't honor once the process has started.
let dir: string;
let sessionStore: ReturnType<typeof createSessionStore>;
let client: ReturnType<typeof createApiClient>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-apiclient-test-"));
  sessionStore = createSessionStore(dir);
  client = createApiClient(sessionStore.loadSession);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

describe("createApiClient", () => {
  test("requestCode posts the email and resolves on a 200", async () => {
    let capturedBody: unknown;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    await client.requestCode("dev@example.com");
    expect(capturedBody).toEqual({ email: "dev@example.com" });
  });

  test("an unreachable network (fetch throws) surfaces as ApiUnreachableError, distinct from a server rejection", async () => {
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    await expect(client.requestCode("dev@example.com")).rejects.toBeInstanceOf(ApiUnreachableError);
  });

  test("a real 4xx/5xx from the server surfaces as ApiRequestError, not ApiUnreachableError — the offline-grace rule must only trigger on the former", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "Invalid code" }), { status: 401 })) as unknown as typeof fetch;

    sessionStore.saveSession("existing-token", "dev@example.com");
    try {
      await client.getEntitlements();
      throw new Error("expected getEntitlements to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect(err).not.toBeInstanceOf(ApiUnreachableError);
      expect((err as ApiRequestError).status).toBe(401);
      expect((err as ApiRequestError).message).toBe("Invalid code");
    }
  });

  test("getEntitlements attaches the stored session token as a bearer header", async () => {
    sessionStore.saveSession("my-jwt-token", "dev@example.com");
    let capturedAuth: string | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string>)?.authorization;
      return new Response(JSON.stringify({ tier: "pro", flags: {}, cacheTtlSeconds: 900 }), { status: 200 });
    }) as typeof fetch;

    const result = await client.getEntitlements();
    expect(capturedAuth).toBe("Bearer my-jwt-token");
    expect(result.tier).toBe("pro");
    expect(result.cacheTtlSeconds).toBe(900);
  });

  test("getEntitlements without a stored session rejects locally, before ever calling fetch", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(client.getEntitlements()).rejects.toBeInstanceOf(ApiRequestError);
    expect(fetchCalled).toBe(false);
  });
});

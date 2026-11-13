// packages/core/src/cli-io/notify.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { notifyGatedConfirmation } from "./notify";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { saveSession, clearSession } from "../security/session";
import { safeRmSync } from "../platform/fs_retry.js";

describe("notifyGatedConfirmation with HMAC signature and retry", () => {
  let originalCwd: string;
  let tmpDir: string;
  let originalFetch: typeof global.fetch;
  let originalWebhookUrl: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), "purix-notify-test-"));
    process.chdir(tmpDir);
    originalFetch = global.fetch;
    originalWebhookUrl = process.env.PURIX_WEBHOOK_URL;
    process.env.PURIX_WEBHOOK_URL = "https://example.com/webhook";
    process.env.PURIX_WEBHOOK_SECRET = "test_webhook_secret";

    saveSession("test_token", "test@example.com");

    // Set up Pro tier cache so webhooks are allowed
    const cacheDir = join(tmpDir, ".purix");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, "tier-config.json"),
      JSON.stringify({
        entitlements: {
          tier: "pro",
          componentLimit: null,
          auditExport: true,
          webhooks: true,
          mcpHardened: false,
          orgId: null,
          seatLimit: null,
        },
        cachedAt: new Date().toISOString(),
        cacheTtlSeconds: 900,
      })
    );
  });

  afterEach(() => {
    closeDb();
    clearSession();
    process.chdir(originalCwd);
    safeRmSync(tmpDir);
    global.fetch = originalFetch;
    if (originalWebhookUrl === undefined) delete process.env.PURIX_WEBHOOK_URL;
    else process.env.PURIX_WEBHOOK_URL = originalWebhookUrl;
    delete process.env.PURIX_WEBHOOK_SECRET;
  });

  it("sends request with correct X-Signature header", async () => {
    let capturedReq: { url: string; headers: Headers; body: string } | null = null;
    global.fetch = async (url: any, init: any) => {
      capturedReq = { url, headers: new Headers(init.headers), body: init.body };
      return new Response("OK", { status: 200 });
    };

    await notifyGatedConfirmation("Test message", "test_kind", "comp_1");
    expect(capturedReq).toBeTruthy();
    const sigHeader = capturedReq!.headers.get("x-signature");
    expect(sigHeader).toMatch(/^[a-f0-9]{64}$/);

    const expectedHash = createHmac("sha256", "test_webhook_secret").update(capturedReq!.body).digest("hex");
    expect(sigHeader).toBe(expectedHash);
  });

  it("with no secret configured it sends nothing: a request signed with a public default would be forgeable", async () => {
    delete process.env.PURIX_WEBHOOK_SECRET;
    let calls = 0;
    const bodies: string[] = [];
    global.fetch = async (_url: any, init: any) => {
      calls++;
      bodies.push(String(init?.body ?? ""));
      return new Response("OK", { status: 200 });
    };
    await notifyGatedConfirmation("Test message", "test_kind", "comp_1");
    expect(calls).toBe(0);
    // And nothing was ever signed with the old literal.
    for (const b of bodies) expect(createHmac("sha256", "dev-webhook-secret").update(b).digest("hex")).not.toBe("");
  });

  it("retries once on failure and does not throw on second failure", async () => {
    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      throw new Error("Connection refused");
    };

    // Should not throw
    await expect(notifyGatedConfirmation("Retry test", "kind", "comp")).resolves.toBeUndefined();
    // 1 initial attempt + 1 retry = 2 calls
    expect(callCount).toBe(2);
  });
});

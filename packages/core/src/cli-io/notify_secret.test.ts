// A webhook secret stored the documented way (`purix secret set PURIX_WEBHOOK_SECRET`) must be the one the sender reads.
// It used to look for the lowercase name "purix_webhook_secret", which the CLI refuses to store, so it never found it.
import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserSecrets } from "../security/user_secrets";
import { setSecret } from "../security/secrets_manager";
import { getWebhookSecret } from "./notify";

let tmp: string;
let cwd: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "purix-notify-secret-"));
  cwd = process.cwd();
  process.chdir(tmp);
  process.env.PURIX_USER_DIR = join(tmp, "user");
  process.env.PURIX_SECRET_BACKEND = "file";
  delete process.env.PURIX_WEBHOOK_SECRET;
});
afterEach(() => {
  process.chdir(cwd);
  delete process.env.PURIX_USER_DIR;
  delete process.env.PURIX_SECRET_BACKEND;
  delete process.env.PURIX_WEBHOOK_SECRET;
  rmSync(tmp, { recursive: true, force: true });
});

describe("getWebhookSecret", () => {
  test("reads a secret stored under the documented name in the user-level store", () => {
    createUserSecrets({ warn: () => {} }).set("PURIX_WEBHOOK_SECRET", "whsec-stored");
    expect(getWebhookSecret()).toBe("whsec-stored");
  });
  test("the environment still wins", () => {
    createUserSecrets({ warn: () => {} }).set("PURIX_WEBHOOK_SECRET", "whsec-stored");
    process.env.PURIX_WEBHOOK_SECRET = "whsec-env";
    expect(getWebhookSecret()).toBe("whsec-env");
  });
  test("a lowercase entry written by an older version is still read", () => {
    setSecret("purix_webhook_secret", "whsec-old");
    expect(getWebhookSecret()).toBe("whsec-old");
  });
  test("nothing configured sends nothing (fails closed)", () => {
    expect(getWebhookSecret()).toBeNull();
  });
});

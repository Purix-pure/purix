// The user-level credential store: one place per person, keyring first, an announced file fallback, and a lookup order that
// puts the environment first. The keyring is a fake here, so these tests prove Purix's rules (fallback, read-back, where a
// value is and is not written). They do NOT prove that the real OS keyring works on any machine; that needs a run on each OS.
import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserSecrets, credentialLocations, resetUserSecretsWarningsForTests, resolveCredential, type KeyringModuleLike } from "./user_secrets";

let dir: string;
let other: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["PURIX_USER_DIR", "PURIX_SECRET_BACKEND", "GEMINI_API_KEY", "OPENAI_API_KEY"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-usersec-"));
  other = mkdtempSync(join(tmpdir(), "purix-usersec-cwd-"));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  resetUserSecretsWarningsForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
});

/** A keyring that remembers values in memory. `misbehave` changes what it does. */
function fakeKeyring(misbehave?: "set-throws" | "no-readback" | "get-throws") {
  const data = new Map<string, string>();
  const mod: KeyringModuleLike = {
    Entry: class {
      constructor(private service: string, private user: string) {}
      getPassword() {
        if (misbehave === "get-throws") throw new Error("platform storage unavailable");
        if (misbehave === "no-readback") return null;
        return data.get(`${this.service}/${this.user}`) ?? null;
      }
      setPassword(v: string) {
        if (misbehave === "set-throws") throw new Error("AccessDenied");
        data.set(`${this.service}/${this.user}`, v);
      }
      deletePassword() {
        return data.delete(`${this.service}/${this.user}`);
      }
    },
  };
  return { mod, data };
}

const allFileText = (d: string) =>
  readdirSync(d)
    .map((f) => readFileSync(join(d, f), "utf-8"))
    .join("\n");

describe("keyring backend", () => {
  test("a stored key lives in the keyring and is in no file Purix writes", () => {
    const kr = fakeKeyring();
    const warnings: string[] = [];
    const s = createUserSecrets({ dir, keyring: kr.mod, platform: "win32", warn: (m) => warnings.push(m) });
    const r = s.set("GEMINI_API_KEY", "AIzaSy-super-secret-value");
    expect(r).toEqual({ backend: "keyring", fellBack: false });
    expect(s.get("GEMINI_API_KEY")).toBe("AIzaSy-super-secret-value");
    expect(allFileText(dir)).not.toContain("AIzaSy-super-secret-value");
    expect(readdirSync(dir)).toEqual(["user-secrets.index.json"]); // no encrypted file, no master key
    expect(warnings).toEqual([]);
    expect(s.list()).toMatchObject([{ name: "GEMINI_API_KEY", backend: "keyring", rotationCount: 0 }]);
  });

  test("a write the keyring accepts but does not read back falls back to the file, and says so", () => {
    const kr = fakeKeyring("no-readback");
    const warnings: string[] = [];
    const s = createUserSecrets({ dir, keyring: kr.mod, platform: "win32", warn: (m) => warnings.push(m) });
    expect(s.set("GEMINI_API_KEY", "abc123")).toEqual({ backend: "file", fellBack: true });
    expect(s.get("GEMINI_API_KEY")).toBe("abc123");
    expect(warnings.join("\n")).toContain("did not return the same value");
    expect(readdirSync(dir)).toContain("user-secrets.enc.json");
  });

  test("a keyring that throws on write falls back to the file in auto mode and refuses to in keyring mode", () => {
    const warnings: string[] = [];
    const auto = createUserSecrets({ dir, keyring: fakeKeyring("set-throws").mod, platform: "win32", warn: (m) => warnings.push(m) });
    expect(auto.set("GEMINI_API_KEY", "abc123").backend).toBe("file");
    expect(warnings.join("\n")).toContain("AccessDenied");

    const strict = createUserSecrets({ dir: mkdtempSync(join(tmpdir(), "purix-usersec-strict-")), keyring: fakeKeyring("set-throws").mod, platform: "win32", mode: "keyring" });
    expect(() => strict.set("GEMINI_API_KEY", "abc123")).toThrow(/does not fall back to a file/);
  });

  test("an entry kept in the keyring is never silently reported as missing when the keyring cannot be read", () => {
    const kr = fakeKeyring();
    const s1 = createUserSecrets({ dir, keyring: kr.mod, platform: "win32" });
    s1.set("GEMINI_API_KEY", "abc123");
    const s2 = createUserSecrets({ dir, keyring: fakeKeyring("get-throws").mod, platform: "win32" });
    expect(() => s2.get("GEMINI_API_KEY")).toThrow(/stored in the OS keyring, which could not be read/);
    const s3 = createUserSecrets({ dir, keyring: null, platform: "win32" });
    expect(() => s3.get("GEMINI_API_KEY")).toThrow(/keyring package cannot be loaded/);
  });

  test("replacing a key moves it between backends without leaving a copy behind", () => {
    const kr = fakeKeyring();
    const s = createUserSecrets({ dir, keyring: kr.mod, platform: "win32" });
    s.set("GEMINI_API_KEY", "first");
    expect(kr.data.size).toBe(1);
    const fileOnly = createUserSecrets({ dir, keyring: kr.mod, platform: "win32", mode: "file", warn: () => {} });
    fileOnly.set("GEMINI_API_KEY", "second");
    expect(kr.data.size).toBe(0);
    expect(fileOnly.get("GEMINI_API_KEY")).toBe("second");
    expect(fileOnly.list()).toMatchObject([{ backend: "file", rotationCount: 1 }]);
    s.set("GEMINI_API_KEY", "third"); // back to the keyring: the file copy goes
    expect(createUserSecrets({ dir, keyring: kr.mod, platform: "win32" }).get("GEMINI_API_KEY")).toBe("third");
    expect(allFileText(dir)).not.toContain("second");
  });
});

describe("when the keyring cannot be used", () => {
  test("Linux with no desktop session uses the file and names the reason", () => {
    const warnings: string[] = [];
    const s = createUserSecrets({ dir, keyring: fakeKeyring().mod, platform: "linux", dbusAddress: undefined, warn: (m) => warnings.push(m) });
    expect(s.set("GEMINI_API_KEY", "abc123")).toEqual({ backend: "file", fellBack: true });
    expect(warnings.join("\n")).toContain("DBUS_SESSION_BUS_ADDRESS is not set");
    expect(s.describe().kind).toBe("file");
  });

  test("Linux with a desktop session uses the keyring", () => {
    const s = createUserSecrets({ dir, keyring: fakeKeyring().mod, platform: "linux", dbusAddress: "unix:path=/run/user/1000/bus" });
    expect(s.set("GEMINI_API_KEY", "abc123").backend).toBe("keyring");
    expect(s.describe().kind).toBe("keyring");
  });

  test("the keyring package missing: auto uses the file, keyring mode fails clearly", () => {
    const warnings: string[] = [];
    const auto = createUserSecrets({ dir, keyring: null, platform: "darwin", warn: (m) => warnings.push(m) });
    expect(auto.set("GEMINI_API_KEY", "abc123").backend).toBe("file");
    expect(warnings.join("\n")).toContain("@napi-rs/keyring is not installed");
    const strict = createUserSecrets({ dir: mkdtempSync(join(tmpdir(), "purix-usersec-s2-")), keyring: null, platform: "darwin", mode: "keyring" });
    expect(() => strict.set("GEMINI_API_KEY", "abc123")).toThrow(/PURIX_SECRET_BACKEND=keyring was asked for/);
  });

  test("PURIX_SECRET_BACKEND=file never touches the keyring, and says nothing (it was asked for)", () => {
    process.env.PURIX_SECRET_BACKEND = "file";
    const kr = fakeKeyring();
    const warnings: string[] = [];
    const s = createUserSecrets({ dir, keyring: kr.mod, platform: "win32", warn: (m) => warnings.push(m) });
    expect(s.set("GEMINI_API_KEY", "abc123")).toEqual({ backend: "file", fellBack: false });
    expect(kr.data.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("an unknown PURIX_SECRET_BACKEND value is reported and treated as auto", () => {
    process.env.PURIX_SECRET_BACKEND = "vault";
    const warnings: string[] = [];
    createUserSecrets({ dir, keyring: null, platform: "darwin", warn: (m) => warnings.push(m) });
    expect(warnings.join("\n")).toContain('PURIX_SECRET_BACKEND="vault"');
  });
});

describe("file backend", () => {
  test("round trip, rotation count, removal; the encrypted file has its own master key and no plaintext", () => {
    const s = createUserSecrets({ dir, keyring: null, platform: "darwin", warn: () => {} });
    s.set("OPENAI_API_KEY", "sk-plain-text-value");
    expect(s.get("OPENAI_API_KEY")).toBe("sk-plain-text-value");
    expect(readdirSync(dir).sort()).toEqual(["user-secrets.enc.json", "user-secrets.index.json", "user-secrets.master.key"]);
    expect(readFileSync(join(dir, "user-secrets.enc.json"), "utf-8")).not.toContain("sk-plain-text-value");
    s.set("OPENAI_API_KEY", "sk-second");
    expect(s.list()).toMatchObject([{ name: "OPENAI_API_KEY", rotationCount: 1, backend: "file", rotationDue: false }]);
    expect(s.remove("OPENAI_API_KEY")).toBe(true);
    expect(s.get("OPENAI_API_KEY")).toBeNull();
    expect(s.remove("OPENAI_API_KEY")).toBe(false);
  });

  test("a damaged index is not replaced by an empty one", () => {
    const s = createUserSecrets({ dir, keyring: null, platform: "darwin", warn: () => {} });
    s.set("OPENAI_API_KEY", "sk-x");
    writeFileSync(join(dir, "user-secrets.index.json"), "{not json");
    expect(() => s.set("GEMINI_API_KEY", "y")).toThrow(/credential index .* could not be read/);
    expect(readFileSync(join(dir, "user-secrets.index.json"), "utf-8")).toBe("{not json");
  });

  test("the default store follows PURIX_USER_DIR, not the folder a command runs in", () => {
    process.env.PURIX_USER_DIR = dir;
    const here = process.cwd();
    try {
      process.chdir(other);
      createUserSecrets({ keyring: null, platform: "darwin", warn: () => {} }).set("GEMINI_API_KEY", "from-folder-a");
      mkdirSync(join(other, "sub"));
      process.chdir(join(other, "sub")); // a different folder, one level down
      expect(createUserSecrets({ keyring: null, platform: "darwin", warn: () => {} }).get("GEMINI_API_KEY")).toBe("from-folder-a");
    } finally {
      process.chdir(here);
    }
    expect(readdirSync(other)).toEqual(["sub"]); // nothing was written next to where the command ran
  });
});

describe("resolveCredential: environment, then user store, then the old folder store", () => {
  const user = () => createUserSecrets({ dir, keyring: null, platform: "darwin", warn: () => {} });

  test("the environment beats a stored key (the old order let a stale stored key win)", () => {
    const s = user();
    s.set("GEMINI_API_KEY", "stored-old");
    process.env.GEMINI_API_KEY = "env-good";
    expect(resolveCredential("GEMINI_API_KEY", { userSecrets: s, projectLookup: () => null })).toEqual({ value: "env-good", source: "environment" });
    expect(credentialLocations("GEMINI_API_KEY", { userSecrets: s, projectLookup: () => null })).toMatchObject({ uses: "environment", conflict: true, environment: true, userStore: true });
  });

  test("the user store beats the old folder store", () => {
    const s = user();
    s.set("GEMINI_API_KEY", "user-value");
    expect(resolveCredential("GEMINI_API_KEY", { userSecrets: s, projectLookup: () => "folder-value", warn: () => {} })).toEqual({ value: "user-value", source: "user_store" });
  });

  test("the old folder store still works, and tells the person how to move it, once", () => {
    const warnings: string[] = [];
    const got = resolveCredential("GEMINI_API_KEY", { userSecrets: user(), projectLookup: () => "folder-value", warn: (m) => warnings.push(m) });
    expect(got).toEqual({ value: "folder-value", source: "project_store" });
    expect(warnings.join("\n")).toContain("purix secret migrate");
  });

  test("nothing anywhere is null, and an unreadable old store does not turn into a different error", () => {
    expect(
      resolveCredential("GEMINI_API_KEY", {
        userSecrets: user(),
        projectLookup: () => {
          throw new Error("old store damaged");
        },
      })
    ).toBeNull();
  });

  test("an empty environment variable is treated as not set", () => {
    process.env.GEMINI_API_KEY = "";
    const s = user();
    s.set("GEMINI_API_KEY", "stored");
    expect(resolveCredential("GEMINI_API_KEY", { userSecrets: s, projectLookup: () => null })?.source).toBe("user_store");
  });
});

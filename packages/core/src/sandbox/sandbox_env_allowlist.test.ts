// packages/core/src/sandbox/sandbox_env_allowlist.test.ts
//
// A4-1 minimal (security review, finding V1b; probe env.mts). The sandbox environment used to be a NAME DENY-LIST
// (API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL): 9 of 15 credential-like names passed through, among them AWS_ACCESS_KEY_ID,
// DATABASE_URL, SSH_AUTH_SOCK and KUBECONFIG. It is now an ALLOW-LIST: a child process sees the variables a toolchain needs to
// run and nothing else, and HOME is a scratch directory instead of the person's own.
import { describe, it } from "node:test";
import { expect } from "expect";
import { sandboxEnv } from "./sandbox_env";

// The fifteen credential-like names of the security review's probe: nine of them passed the old deny-list.
const CREDENTIAL_LIKE = [
  "AWS_ACCESS_KEY_ID", "AWS_SESSION_TOKEN", "DATABASE_URL", "SSH_AUTH_SOCK", "KUBECONFIG",
  "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_ID", "DOCKER_AUTH_CONFIG", "NPM_CONFIG__AUTH", "SENTRY_DSN",
  "REDIS_URL", "MONGODB_URI", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN",
];

describe("sandboxEnv: an allow-list", () => {
  it("passes none of the fifteen credential-like names (the old deny-list let 9 through)", () => {
    const source = Object.fromEntries(CREDENTIAL_LIKE.map((k) => [k, "secret-value"]));
    const env = sandboxEnv({ source: { ...source, PATH: "/usr/bin" } });
    for (const k of CREDENTIAL_LIKE) expect(env[k]).toBeUndefined();
    expect(Object.values(env)).not.toContain("secret-value");
  });

  it("keeps what a toolchain needs to start: PATH, locale, time zone, terminal and colour switches, temp dirs, CI, NODE_ENV", () => {
    const source = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "C", LC_CTYPE: "UTF-8", TZ: "UTC", TERM: "xterm", NO_COLOR: "1", FORCE_COLOR: "0", CI: "true", NODE_ENV: "test", TMPDIR: "/tmp", TMP: "/tmp", TEMP: "/tmp" };
    const env = sandboxEnv({ source });
    for (const [k, v] of Object.entries(source)) expect(env[k]).toBe(v);
  });

  it("drops everything not on the list, including harmless-looking and Purix's own variables", () => {
    const env = sandboxEnv({ source: { PATH: "/bin", EDITOR: "vim", PURIX_LLM_PROVIDER: "openai", SHELL: "/bin/zsh", NODE_OPTIONS: "--require x", LD_PRELOAD: "/x.so", PYTHONPATH: "/p", HISTFILE: "/h" } });
    expect(Object.keys(env).sort()).toEqual(["PATH"]);
  });

  it("matches Windows names without regard to case and keeps the original spelling", () => {
    const env = sandboxEnv({ source: { Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\cmd.exe", PATHEXT: ".EXE", USERPROFILE: "C:\\Users\\me", APPDATA: "C:\\Users\\me\\AppData" } });
    expect(env.Path).toBe("C:\\Windows");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.ComSpec).toBe("C:\\Windows\\cmd.exe");
    expect(env.PATHEXT).toBe(".EXE");
    expect(env.USERPROFILE).toBeUndefined();
    expect(env.APPDATA).toBeUndefined();
  });

  it("never passes NODE_TEST_CONTEXT (a nested node --test would read it as a duplicate run and skip every test)", () => {
    expect(sandboxEnv({ source: { NODE_TEST_CONTEXT: "child-v8" } }).NODE_TEST_CONTEXT).toBeUndefined();
  });

  it("skips undefined values", () => {
    expect(sandboxEnv({ source: { PATH: undefined, LANG: "C" } })).toEqual({ LANG: "C" });
  });
});

describe("sandboxEnv: HOME is a scratch directory, not the person's home", () => {
  it("sets HOME (and USERPROFILE for Windows tools) to the directory it is given, ignoring the real one", () => {
    const env = sandboxEnv({ source: { HOME: "/home/me", USERPROFILE: "C:\\Users\\me", PATH: "/bin" }, home: "/scratch/run1" });
    expect(env.HOME).toBe("/scratch/run1");
    expect(env.USERPROFILE).toBe("/scratch/run1");
  });
  it("with no directory given there is no HOME at all, rather than the real one", () => {
    const env = sandboxEnv({ source: { HOME: "/home/me", PATH: "/bin" } });
    expect(env.HOME).toBeUndefined();
  });
});

describe("sandboxEnv: PURIX_SANDBOX_ENV_PASS is the person's own opt-in", () => {
  it("passes exactly the names listed, even a credential-like one, because the person named it", () => {
    const env = sandboxEnv({ source: { PATH: "/bin", JAVA_HOME: "/jdk", MY_TOKEN: "t", OTHER: "o", PURIX_SANDBOX_ENV_PASS: "JAVA_HOME, MY_TOKEN ,," } });
    expect(env.JAVA_HOME).toBe("/jdk");
    expect(env.MY_TOKEN).toBe("t");
    expect(env.OTHER).toBeUndefined();
    expect(env.PURIX_SANDBOX_ENV_PASS).toBeUndefined();
  });
  it("a name that is not a plain variable name is ignored, so the list cannot be used to pass patterns", () => {
    const env = sandboxEnv({ source: { PATH: "/bin", A: "1", B: "2", PURIX_SANDBOX_ENV_PASS: "*,A B,A=1,B" } });
    expect(env.A).toBeUndefined();
    expect(env.B).toBe("2");
  });
});

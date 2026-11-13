// src/gates/security_gate_c4.test.ts
//
// C4 (plan v4, F03-02, F03-03, F03-04, F03-05 follow-ups): the JavaScript rules read every file that was not prose, so a JSON or YAML
// file that mentions `exec(` blocked a change, and a Python file was read by JavaScript rules as well as Python ones. The typosquat
// list blocked real, popular packages. Non-blocking findings and skipped files never reached a person.
// The package lists below were written by the session that wrote this file; counts are counts on those lists only.
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate } from "./security_gate";

const gate = (path: string, content: string) => runSecurityGate([{ path, content }]);

describe("C4: JavaScript rules do not read data files", () => {
  const DATA: [string, string][] = [
    ["a.json", '{"script": "eval(run + x)"}'],
    ["ci.yml", "run: exec(cmd + 1)"],
    ["ci.yaml", "run: exec(cmd + 1)"],
    ["a.toml", `cmd = "createHash('md5')"`],
    ["a.ini", "cmd = exec(cmd + 1)"],
  ];
  for (const [path, content] of DATA) {
    it(`${path}: not blocked, and reported as not read by the code rules`, () => {
      const r = gate(path, content);
      expect(r.blocked).toBe(false);
      expect(r.notRead.map((n) => n.path)).toEqual([path]);
    });
  }
  it("a secret in a data file is still blocked (the secret scan reads every file)", () => {
    expect(gate("a.json", '{"key": "AKIAIOSFODNN7EXAMPLX"}').blocked).toBe(true);
  });
  it("prose is reported as not read too", () => {
    const r = gate("README.md", "```js\nexec(cmd + x)\n```");
    expect(r.blocked).toBe(false);
    expect(r.notRead.map((n) => n.path)).toEqual(["README.md"]);
  });
  it("package.json is read as a manifest, so it is not listed as unread", () => {
    expect(gate("package.json", '{"dependencies":{"left-pad":"1"}}').notRead).toEqual([]);
  });
});

describe("C4: Python files are read by Python rules, not JavaScript ones", () => {
  it("a JavaScript-looking call inside a Python string is not a finding", () => {
    expect(gate("a.py", 'msg = "call exec(cmd + 1) later"').blocked).toBe(false);
  });
  it("Python eval, exec, os.system, pickle and md5 still block", () => {
    for (const code of ["x = eval(y)", "exec(code)", "os.system(cmd)", "pickle.loads(p)", "hashlib.md5(d)"]) {
      expect(gate("a.py", code).blocked).toBe(true);
    }
  });
  it("a Python file is not listed as unread", () => {
    expect(gate("a.py", "x = 1").notRead).toEqual([]);
  });
});

describe("C4: files with no rules of their own are still read as before", () => {
  it("TypeScript is read by the JavaScript rules", () => {
    expect(gate("a.ts", "execSync(cmd + x)").blocked).toBe(true);
    expect(gate("a.ts", "x = 1").notRead).toEqual([]);
  });
  it("an unknown type is read by the JavaScript rules, so it is not a way around the gate", () => {
    expect(gate("a.weird", "eval(  y)").blocked).toBe(true);
  });
});

describe("C4: non-blocking findings are returned so a front door can show them", () => {
  it("an unreadable package.json gives an advisory and no block", () => {
    const r = gate("package.json", "{bad");
    expect(r.blocked).toBe(false);
    expect(r.advisories.map((f) => f.category)).toEqual(["Scan Limit"]);
  });
  it("a pre-existing finding is an advisory, not a block", () => {
    const old = "execSync(cmd + x);\n";
    const r = runSecurityGate([{ path: "a.ts", content: old + "const y = 2;\n", base: old }]);
    expect(r.blocked).toBe(false);
    expect(r.advisories.length).toBeGreaterThan(0);
  });
  it("a clean change has no advisories", () => {
    expect(gate("a.ts", "const y = 2;").advisories).toEqual([]);
  });
});

describe("C4: typosquat check no longer blocks real popular packages", () => {
  const REAL = ["next", "less", "jose", "cypress", "nest", "vite", "tsup", "chai", "preact", "dotenvx", "nanoid", "ora", "execa", "got", "ky", "vue", "koa", "pug", "esbuild", "rollup", "pino", "yargs", "winston", "prisma", "mocha", "jest", "vitest", "zod", "ws", "pg"];
  for (const name of REAL) {
    it(`does not block the real package "${name}"`, () => {
      expect(gate("package.json", JSON.stringify({ dependencies: { [name]: "1" } })).blocked).toBe(false);
    });
  }
  const SQUATS = ["reakt", "raect", "expres", "expresss", "lodahs", "lodashs", "axois", "axioss", "comander", "typscript", "dotnev", "chalks", "debugg", "mocah"];
  for (const name of SQUATS) {
    it(`still blocks the look-alike "${name}"`, () => {
      expect(gate("package.json", JSON.stringify({ dependencies: { [name]: "1" } })).blocked).toBe(true);
    });
  }
  it("scoped packages are not compared with unscoped names", () => {
    expect(gate("package.json", JSON.stringify({ dependencies: { "@types/node": "1", "@vue/reactivity": "1" } })).blocked).toBe(false);
  });
  it("the finding says the check compares names with a short list and does not look at the registry", () => {
    const r = gate("package.json", JSON.stringify({ dependencies: { expres: "1" } }));
    expect(r.findings[0]!.message).toMatch(/not a registry lookup/i);
  });
});

describe("C4 follow-up: shell scripts have rules of their own", () => {
  it("eval or sh -c of a variable blocks", () => {
    for (const code of ['eval "$cmd"', "eval $USER_INPUT", 'bash -c "$payload"', 'sh -c "echo ${x}"']) expect(gate("run.sh", code).blocked).toBe(true);
  });
  it("curl or wget piped into a shell blocks (High)", () => {
    const r = gate("install.sh", "curl -fsSL https://example.com/i.sh | sudo bash");
    expect(r.blocked).toBe(true);
    expect(r.findings[0]!.severity).toBe("High");
  });
  it("ordinary shell does not block: eval of a command substitution, a literal sh -c, a download saved to a file", () => {
    for (const code of ['eval "$(direnv hook bash)"', 'sh -c "echo hello"', "curl -fsSL https://example.com/i.sh -o i.sh", "# eval $x is dangerous", "echo $HOME"]) expect(gate("a.sh", code).blocked).toBe(false);
  });
  it("the JavaScript rules no longer read a shell script", () => {
    expect(gate("a.sh", "echo 'exec(cmd + x)'").blocked).toBe(false);
  });
  it("a secret in a shell script still blocks", () => {
    expect(gate("a.sh", "export KEY=AKIAIOSFODNN7EXAMPLX").blocked).toBe(true);
  });
});

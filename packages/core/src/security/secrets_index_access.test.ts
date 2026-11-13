// src/security/secrets_index_access.test.ts
//
// Found by reading real third-party code: `password: parts[2]` (a lookup, not a literal) was flagged as an unquoted password.
// An index access reads like a member access (`req.body.pass1`) and is exempt the same way. A real value still blocks.
import { describe, it } from "node:test";
import { expect } from "expect";
import { scanForSecrets } from "./secrets";

const scan = (content: string) => scanForSecrets([{ path: "src/a.ts", content }]);

describe("unquoted password rule does not flag an index access", () => {
  for (const line of ["password: parts[2]", "password = args[1]", "const pwd = row[0]", "DB_PASSWORD: creds[3]", "token: parts[2]", "auth_token = args[1]"]) {
    it(`not flagged: ${line}`, () => {
      expect(scan(line)).toEqual([]);
    });
  }
  for (const line of ["DB_PASSWORD=hunter2hunter2", "password: a8Kd92xLq1", "export PGPASSWORD=s3cr3tvalue9"]) {
    it(`still flagged: ${line}`, () => {
      expect(scan(line).length).toBeGreaterThan(0);
    });
  }
});

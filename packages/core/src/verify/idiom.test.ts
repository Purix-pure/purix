// src/verify/idiom.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { checkIdioms } from "./idiom";
import * as os from "node:os";

describe("Verify Idiom", () => {
  it("exists as a function", () => {
    expect(typeof checkIdioms).toBe("function");
  });

  it("returns {findings: [], ran: false} when eslint binary is missing", () => {
    // Pass a directory that definitely doesn't have node_modules
    const fakeDir = os.tmpdir();
    const result = checkIdioms(["src/verify/idiom.ts"], fakeDir);
    expect(result.ran).toBe(false);
  });
});

// src/tools/real_install.test.ts
//
// Real installs against the real registries, with the real shipped lock text. Network + Python/npm
// required, so it is OFF unless PURIX_REAL_TOOL_INSTALL=1 (ADR-060 Confirmation item 6). Never
// run in the default suite: CI must not depend on registry availability.
import { describe, it } from "node:test";
import { expect } from "expect";
import { join } from "node:path";
import { getToolBinary, installTool } from "./broker.js";
import { spawnSync } from "../platform/spawn_sync.js";
import { toolsDir } from "./state.js";
import { fixedGate, memoryAudit, tempProject } from "./test_helpers.js";

const ON = process.env.PURIX_REAL_TOOL_INSTALL === "1";

describe("real installs (opt-in)", { skip: !ON }, () => {
  for (const id of ["ruff", "typescript"]) {
    it(`installs ${id} from the shipped lock and the binary runs`, async () => {
      const p = tempProject();
      try {
        const r = await installTool({ baseDir: p.dir, audit: memoryAudit(), consent: fixedGate(true) }, id);
        if (!r.ok) throw new Error(`${r.reason}: ${r.message}`);
        const bin = getToolBinary({ baseDir: p.dir }, id)!;
        const out = spawnSync([bin, "--version"], { cwd: p.dir, stdout: "pipe", stderr: "pipe" });
        expect(out.exitCode).toBe(0);
        expect(out.stdout.toString()).toMatch(id === "ruff" ? /0\.8\.4/ : /5\.7\.2/);
        expect(bin.startsWith(toolsDir(p.dir))).toBe(true);
      } finally { p.cleanup(); }
    });
  }
});

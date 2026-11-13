// scripts/test-home-preload.mjs
//
// Preloaded into every test file with `node --import`. `node --test` runs each test file in its own process, and
// this gives each of those processes its own empty home folder. Without it, files that save and clear the
// machine-wide login (~/.purix/session.enc: tier.test.ts, tier_signed.test.ts, ...) log each other out when they run
// at the same time, and they overwrite the developer's real login. See the same note in packages/core/scripts/run-tests.mjs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "purix-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // best effort: it is a temp directory
  }
});

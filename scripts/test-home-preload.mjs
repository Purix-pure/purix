// scripts/test-home-preload.mjs
//
// Preloaded into every test file with `node --import`. `node --test` runs each test file in its own process, and
// this gives each of those processes its own empty home folder. Without it, files that save and clear the
// machine-wide login (~/.purix/session.enc: tier.test.ts, tier_signed.test.ts, ...) log each other out when they run
// at the same time, and they overwrite the developer's real login. See the same note in packages/core/scripts/run-tests.mjs.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Remember the real home before it is replaced, so code that starts the Python launcher (which keeps its settings and runtime in the
// user's profile) can still run it against the real one: in an empty throw-away profile the Windows launcher hung until its stop.
if (process.env.PURIX_REAL_HOME === undefined) process.env.PURIX_REAL_HOME = process.env.HOME ?? "";
if (process.env.PURIX_REAL_USERPROFILE === undefined) process.env.PURIX_REAL_USERPROFILE = process.env.USERPROFILE ?? "";
const home = mkdtempSync(join(tmpdir(), "purix-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// The temp folder moves inside the throw-away home too. A test that makes a temp folder and then looks UP the folder tree for an old
// Purix store (findFolderStoreDir stops at the home folder) must never reach the developer's own home, where a real store may sit.
// Before this, on a machine whose real temp folder is under the real home (every Windows machine), such tests read and overwrote
// the developer's real secrets file.
const tmpInHome = join(home, "tmp");
mkdirSync(tmpInHome, { recursive: true });
process.env.TMPDIR = tmpInHome; // macOS and Linux
process.env.TEMP = tmpInHome; // Windows
process.env.TMP = tmpInHome;
process.on("exit", () => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // best effort: it is a temp directory
  }
});

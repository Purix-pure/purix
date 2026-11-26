// Preloaded by `pnpm test` in this package. The CLI writes to the user-level Purix folder (the project registry `projects.json`,
// the usage ledger) whenever a command runs, so without this the test suite wrote into the real ~/.purix of whoever ran it.
// PURIX_USER_DIR is what core's userDir() reads first; child processes the tests spawn inherit it.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PURIX_USER_DIR) {
  const dir = mkdtempSync(join(tmpdir(), "purix-cli-test-user-"));
  process.env.PURIX_USER_DIR = dir;
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
}

// The same throw-away home and temp folder as scripts/test-home-preload.mjs in the repository root: a test that makes a temp folder and looks
// UP the folder tree for an old Purix store stops at the home folder (findFolderStoreDir), so with the temp folder inside this home it never
// reaches the developer's real one. Without this, on Windows (real temp folder under the real home) a test could read or overwrite real keys.
if (!process.env.PURIX_TEST_HOME_SET) {
  const home = mkdtempSync(join(tmpdir(), "purix-cli-test-home-"));
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.TMPDIR = tmp;
  process.env.TEMP = tmp;
  process.env.TMP = tmp;
  process.env.PURIX_TEST_HOME_SET = "1";
  process.on("exit", () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });
}

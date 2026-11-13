// packages/core/src/test-support/isolated_cwd.ts
//
// Some code under test opens the project state store (".purix/manifest.db") or reads ".purix/config.json" relative to the
// current directory. A test file that touches it without moving into a throwaway directory first leaves a ".purix" folder
// inside the package (N-14). Call `isolateCwdForFile()` once at the top of such a file: every test in the file then runs in a
// fresh temp directory, the store is closed afterwards, and the directory is removed.
import { before, after } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store.js";
import { safeRmSync } from "../platform/fs_retry.js";

export function isolateCwdForFile(): void {
  let originalCwd = "";
  let dir = "";
  before(() => {
    originalCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "purix-test-cwd-"));
    process.chdir(dir);
  });
  after(() => {
    closeDb();
    process.chdir(originalCwd);
    safeRmSync(dir);
  });
}

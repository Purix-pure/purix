// packages/core/src/platform/user_dir.ts
//
// The one place that answers "where is the user-level Purix folder". It follows the person, never the folder a command runs in:
// `~/.purix`, or the folder named by PURIX_USER_DIR (tests, CI, and anyone who keeps their config elsewhere).
//
// Before this, telemetry consent read PURIX_USER_DIR, approvals read it, and the login session ignored it and used
// `purixDir(homedir())` directly. A key store that used `process.cwd()` (the old secrets_manager default) was the third answer,
// and the reason a key saved in one folder could not be found from another.
import { homedir } from "node:os";
import { purixEnv } from "./env.js";
import { purixDir } from "./layout.js";

/** The user-level Purix folder. Not created here. */
export function userDir(): string {
  const configured = purixEnv("PURIX_USER_DIR");
  return configured !== undefined && configured.trim() !== "" ? configured : purixDir(homedir());
}

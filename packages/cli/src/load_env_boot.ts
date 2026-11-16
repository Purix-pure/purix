// packages/cli/src/load_env_boot.ts
//
// Imported for its effect, first in cli.ts, exactly where `import "dotenv/config"` used to be: several modules read the
// environment while they load, so the project's .env has to be in place before any of them runs. The filtering lives in
// load_env.ts; see there for why some names are ignored.
import { homedir } from "node:os";
import { join } from "node:path";
import { loadProjectEnv, shouldAnnounceIgnored } from "./load_env.js";

const result = loadProjectEnv(process.cwd(), process.env);

// Say so on stderr the first time this folder shows these names, not on every command. `purix hook` runs inside an agent's
// tool loop and must stay silent. The names are ignored on every run either way; only the notice is remembered.
const stateDir = process.env.PURIX_USER_DIR || join(homedir(), ".purix");
if (result.ignored.length > 0 && !process.argv.slice(2).includes("hook") && shouldAnnounceIgnored(process.cwd(), result.ignored, stateDir)) {
  process.stderr.write(
    `purix: ignored ${result.ignored.join(", ")} from ./.env. Those names change how Purix behaves, so only your shell can set ` +
      `them. This notice shows once for this folder.\n`
  );
}

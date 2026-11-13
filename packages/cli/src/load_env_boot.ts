// packages/cli/src/load_env_boot.ts
//
// Imported for its effect, first in cli.ts, exactly where `import "dotenv/config"` used to be: several modules read the
// environment while they load, so the project's .env has to be in place before any of them runs. The filtering lives in
// load_env.ts; see there for why some names are ignored.
import { loadProjectEnv } from "./load_env.js";

const result = loadProjectEnv(process.cwd(), process.env);

// Say so once, on stderr, when something was ignored. `purix hook` runs inside an agent's tool loop and must stay silent.
if (result.ignored.length > 0 && !process.argv.slice(2).includes("hook")) {
  process.stderr.write(
    `purix: ignored ${result.ignored.join(", ")} from ./.env. Those names change how Purix behaves, so they are only read ` +
      `from your shell, never from a project folder.\n`
  );
}

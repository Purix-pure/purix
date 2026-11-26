// packages/cli/src/cli/commands/panel.ts
//
// `purix panel`: puts the same one line `purix statusline` prints into OpenCode's sidebar. It installs one plugin file and one entry in
// OpenCode's tui.json (project: .opencode/, or --user: ~/.config/opencode/). It never replaces a file or entry that Purix did not write.
// For OpenCode 1.x. Not checked in a live OpenCode session; see core/src/observe/opencode_panel.ts for what was and was not checked.
import type { Command } from "commander";

export function registerPanelCommand(program: Command) {
  program
    .command("panel")
    .description("Show the Purix line in OpenCode's sidebar (OpenCode 1.x; writes one plugin file and one tui.json entry)")
    .option("--install", "write the plugin file and add it to tui.json (the default action)")
    .option("--uninstall", "remove what --install wrote (and only that)")
    .option("--status", "show where it is installed")
    .option("--user", "use ~/.config/opencode/ so every project gets it, instead of this project's .opencode/")
    .action(async (opts: { install?: boolean; uninstall?: boolean; status?: boolean; user?: boolean }) => {
      const chosen = [opts.install, opts.uninstall, opts.status].filter(Boolean).length;
      if (chosen > 1) { console.error("Bad input: choose one of --install, --uninstall, --status."); process.exitCode = 2; return; }
      const mod = await import("@purix/core/observe/opencode_panel");
      const scope = opts.user ? "user" : "project";
      const { findProjectRoot } = await import("@purix/core/platform/project_root");
      const root = findProjectRoot(process.cwd())?.root ?? process.cwd();
      if (opts.status) {
        const s = mod.readPanelState(scope, root);
        console.log(`Plugin file: ${s.filePath}\nConfig:      ${s.configPath}`);
        const st = s.state;
        if (st.state === "not-installed") console.log("Not installed. Run `purix panel --install`.");
        else if (st.state === "installed") console.log(`Installed (${st.entry})${st.fileCurrent ? "" : ". The plugin file is from an older Purix; run `purix panel --install` to update it."}`);
        else if (st.state === "partial") console.log(`Half installed: ${st.problem}. Run \`purix panel --install\`.`);
        else if (st.state === "other-file") console.log(`A file named purix-panel.tsx is there that Purix did not write; it was left alone.`);
        else { console.log(`Could not read it: ${st.error}`); process.exitCode = 1; }
        return;
      }
      if (opts.uninstall) {
        const r = mod.uninstallPanel(scope, root);
        if (!r.ok) { console.error(`Not removed: ${r.error}`); process.exitCode = 1; return; }
        console.log(r.fileRemoved || r.configChanged ? `Removed the Purix panel (${r.fileRemoved ? "plugin file" : "no plugin file"}${r.configChanged ? ", tui.json entry" : ""}).` : "Nothing of Purix's was there.");
        return;
      }
      const r = mod.installPanel(scope, root);
      if (!r.ok) { console.error(`Not installed: ${r.error}.`); process.exitCode = 1; return; }
      console.log(r.fileChanged || r.configChanged ? `Installed the Purix panel:\n  plugin file  ${r.filePath}\n  tui.json     ${r.configPath}` : "Already installed; nothing changed.");
      console.log("Restart OpenCode to load it. It shows the same line as `purix statusline`, in the sidebar, and runs that command every 10 seconds.");
      console.log("For OpenCode 1.x. If your OpenCode version loads TUI plugins differently, `purix panel --status` shows what was written; `purix panel --uninstall` removes it.");
    });
}

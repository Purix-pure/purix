// src/observe/opencode_panel_source.ts
//
// The text of the OpenCode sidebar panel that `purix panel --install` writes. It is one file of Solid JSX for OpenCode's TUI plugin API.
//
// Written against the real type declarations of @opencode-ai/plugin 1.19.6 (`tui.d.ts`: TuiPlugin, TuiPluginModule, the `sidebar_content`
// slot, api.slots.register, api.event.on, api.state.path.directory, api.theme.current, api.lifecycle.onDispose), and against a published
// third-party plugin that uses the same calls. OpenCode 1.x names its slots with underscores. OpenCode's newer "v2" documentation uses a
// different plugin shape and dotted slot names (`sidebar.content`); this file is for the 1.x shape and says so in its header.
//
// What it does: every 10 seconds, and 2 seconds after a tool call finishes, it runs `purix statusline` in the project folder and shows the
// one line it prints. It reads nothing itself, writes nothing, and opens no network connection. If `purix` cannot be run the panel hides.
// The panel and the line therefore always agree, because the panel is that same command.
//
// NOT checked: a live OpenCode session. This file type-checked against the declarations above in the session that wrote it (a one-off
// check, not part of the test suite); the file shape (default export with `id` and `tui`, slot `sidebar_content`) matches a third-party
// plugin reference. Known risk: OpenCode issues #59458 and #66252 report slots that do not repaint on state changes in 2.x builds; if the
// line goes stale, that is the likely cause. Whether OpenCode loads and repaints it is the first real check.
export const PANEL_MARKER = "// purix-panel: managed by `purix panel`. Remove it with `purix panel --uninstall`.";

export const PANEL_FILE_NAME = "purix-panel.tsx";

export const PANEL_SOURCE = `/** @jsxImportSource @opentui/solid */
${PANEL_MARKER}
// For OpenCode 1.x (TuiPlugin API, slot names with underscores). It shows the one line \`purix statusline\` prints, and does nothing else.
import { createSignal, onCleanup } from "solid-js";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

const REFRESH_MS = 10_000;
const AFTER_TOOL_MS = 2_000;
const LIMIT_MS = 5_000;

function readLine(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // require() on purpose: the plugin runtime does not support top-level imports of Node built-ins.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cp = require("child_process") as typeof import("child_process");
      const child = cp.spawn("purix", ["statusline", "--range", "today"], {
        cwd: dir,
        shell: process.platform === "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        timeout: LIMIT_MS,
      });
      let out = "";
      child.stdout?.on("data", (d: unknown) => { if (out.length < 4000) out += String(d); });
      child.on("error", () => resolve(null));
      child.on("close", (code: number | null) => { const first = out.split("\\n")[0]?.trim() ?? ""; resolve(code === 0 && first !== "" ? first : null); });
      child.stdin?.on("error", () => { /* the command may exit before reading */ });
      child.stdin?.end(JSON.stringify({ cwd: dir }));
    } catch {
      resolve(null);
    }
  });
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 50,
    slots: {
      sidebar_content() {
        const theme = () => api.theme.current;
        const [line, setLine] = createSignal<string | null>(null);
        let busy = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const refresh = async () => {
          const dir = api.state.path.directory;
          if (busy || !dir) return;
          busy = true;
          try { setLine(await readLine(dir)); } finally { busy = false; }
        };
        void refresh();
        const every = setInterval(() => void refresh(), REFRESH_MS);
        const offPart = api.event.on("message.part.updated", (e: unknown) => {
          const part = (e as { properties?: { part?: { type?: string } } }).properties?.part;
          if (part?.type !== "tool") return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void refresh(), AFTER_TOOL_MS);
        });
        onCleanup(() => { clearInterval(every); if (timer) clearTimeout(timer); offPart(); });
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- JSX typed by @opentui/solid
        return (
          <box flexDirection="column" visible={!!line()}>
            <text fg={theme().text}>
              <b>Purix</b>
            </text>
            <text fg={theme().textMuted}>{line()}</text>
          </box>
        );
      },
    },
  });
};

const plugin: TuiPluginModule & { id: string } = { id: "purix-panel", tui };

export default plugin;
`;

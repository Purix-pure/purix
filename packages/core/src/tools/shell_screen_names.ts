// src/tools/shell_screen_names.ts
//
// Program NAMES the hook's shell screen (hooks/decide.ts) must recognise in a command an agent is about to run. This is a list of names
// to read, never a command to run: nothing here spawns, installs or locates a tool. It lives under tools/ because ADR-060 keeps every
// bare tool name in this folder (scripts/check-tool-boundary.ts matches the names as text), and the broker owns the list of tools.

/** Package runners: `<runner> [flags] <program> ...` runs <program>, so the screen looks past the runner to the program. */
export const PACKAGE_RUNNER_NAMES: ReadonlySet<string> = new Set(["npx", "bunx", "pnpx"]);

/** Checkers and test runners: they only read a file unless handed a flag that makes them rewrite it (--fix, snapshot update). */
export const CHECKER_NAMES: ReadonlySet<string> = new Set(
  "eslint stylelint tsc vitest jest mocha ava pytest py.test mypy pyright flake8 pylint bandit rubocop".split(" "),
);

// packages/cli/src/cli/launch_dir.ts
//
// cli.ts moves the process to the project root before a command runs (N-3), so process.cwd() no longer says where the
// person typed the command. Commands that need to explain a root/launch mismatch read it from here.
let launchDir: string | undefined;

export function setLaunchDir(dir: string): void {
  launchDir = dir;
}

export function getLaunchDir(): string | undefined {
  return launchDir;
}

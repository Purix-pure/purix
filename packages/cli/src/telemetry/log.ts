// packages/cli/src/telemetry/log.ts
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function getLogDir(): string {
  const dir = join(homedir(), ".purix", "logs");
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
  }
  return dir;
}

function getLogFilePath(): string {
  const dateStr = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return join(getLogDir(), `purix-${dateStr}.log`);
}

export function logError(err: unknown, context?: string): void {
  try {
    const dir = getLogDir();
    const p = getLogFilePath();
    const entry = {
      timestamp: new Date().toISOString(),
      context: context ?? "cli",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      version: "0.2.0-beta.0",
    };
    appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");

    // Clean up logs older than 7 days
    cleanupOldLogs(dir);
  } catch {}
}

function cleanupOldLogs(dir: string): void {
  try {
    const files = readdirNames(dir);
    const now = Date.now();
    for (const file of files) {
      if (file.startsWith("purix-") && file.endsWith(".log")) {
        const fp = join(dir, file);
        const stats = statSync(fp);
        if (now - stats.mtimeMs > 7 * 24 * 60 * 60 * 1000) {
          rmSync(fp, { force: true });
        }
      }
    }
  } catch {}
}

function readdirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function getRecentLogs(maxLines = 50): string[] {
  try {
    const dir = getLogDir();
    const files = readdirNames(dir)
      .filter((f) => f.startsWith("purix-") && f.endsWith(".log"))
      .sort()
      .reverse();

    const lines: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      const fileLines = content.trim().split("\n").filter(Boolean);
      for (const line of fileLines.reverse()) {
        lines.push(line);
        if (lines.length >= maxLines) return lines;
      }
    }
    return lines;
  } catch {
    return [];
  }
}

export function redactLogContent(line: string): string {
  // Redact potential absolute paths, secrets, or api keys
  return line
    .replace(/[C-Z]:\\[^\s"']+/gi, "[REDACTED_PATH]")
    .replace(/\/home\/[^\s"']+/gi, "[REDACTED_PATH]")
    .replace(/\/Users\/[^\s"']+/gi, "[REDACTED_PATH]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED_SECRET]")
    .replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, "bearer [REDACTED_TOKEN]");
}

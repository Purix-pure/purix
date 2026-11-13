// src/gates/security_gate.ts
import { scanForSecrets } from "../security/secrets.js";
import { recordOverrideAudit } from "../security/override_audit.js";
import { lockDeltaFindings } from "./lock_delta.js";
import { isLockfile } from "../security/lock_parsers.js";
import { manifestDelta, isRegistrySpec, type DepPair, type RegistryVerdict } from "../security/dep_delta.js";
import { manifestDeltaFindings, nonRegistryKind, npmrcDeltaFindings } from "./manifest_delta.js";

export type SecuritySeverity = "Critical" | "High" | "Medium" | "Low";

export interface SecurityFindingItem {
  path: string;
  line: number;
  category: string;
  severity: SecuritySeverity;
  message: string;
}

export interface SecurityGateResult {
  ok: boolean;
  findings: SecurityFindingItem[];
  /** C4: findings that do not block (Low and Medium: an old finding, a line or manifest that could not be read in full). A front door shows them. */
  advisories: SecurityFindingItem[];
  /** C4: files the code rules did not read (documentation, data and configuration files), with why. The secret scan still reads every file. */
  notRead: { path: string; reason: string }[];
  blocked: boolean;
  reason?: string;
}

const SQL_INJECTION_RE = /(query|execute|run)\s*\(\s*['"`].*(\+|\$\{)/i;
const COMMAND_INJECTION_RE = /\b(exec|spawn|execSync|spawnSync|eval)\s*\([^)]*(\+|`|\$\{)/;
const WEAK_CRYPTO_RE = /createHash\s*\(\s*['"](md5|sha1)['"]\s*\)|createCipher\(|createDecipher\(/i;
const UNSAFE_DESERIALIZATION_RE = /vm\.runInNewContext|eval\s*\(/;

// Added 2026-10-15 after the periodic security check. All of these work one line at a time, like the rules above, so a
// call split across several lines can still get past them. They are a tripwire that sends the patch to a person, and the
// sandbox plus the confirmation step stay the boundary.
//
// A shell-running call whose command is a variable or an expression (a literal string is left alone: it cannot carry input).
// A bare exec( or any execSync( counts; a dotted .exec( counts only on a receiver that is plainly a child-process handle,
// because regex.exec(text) is everywhere and is not a shell.
const SHELL_CALL_NON_LITERAL_RE = /(?:(?<![.\w$])exec|\bexecSync|\b(?:child_?process|cp|shell|proc|sh)\s*\.\s*exec)\s*\(\s*(?![`'"])[A-Za-z_$(][^,)]*[,)]/i;
// Reaching the process-spawning functions by name in brackets hides the call from every rule above.
const SPAWN_BY_NAME_RE = /\[\s*['"`](?:exec|execSync|spawn|spawnSync)['"`]\s*\]\s*\(/;
const SPAWN_SHELL_OPTION_RE = /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(.*\bshell\s*:\s*true/;
// Building code from text at run time: the same danger as eval.
const DYNAMIC_FUNCTION_RE = /\bnew\s+Function\s*\(|\bFunction\s*\(\s*['"`][^)]*\)\s*\(|\bvm\.(?:runInThisContext|runInContext)\s*\(|\bnew\s+vm\.Script\s*\(/;
// Reading the whole environment at once (a single named variable is not matched) ...
const BULK_ENV_RE = /\bprocess\.env\b(?!\s*(?:\.\s*[A-Za-z_$]|\[\s*['"`]))|\bObject\.(?:entries|keys|values|assign)\s*\(\s*(?:\{\s*\}\s*,\s*)?process\.env\b/;
const NETWORK_CALL_RE = /\b(?:fetch|axios|got|superagent|XMLHttpRequest|WebSocket|sendBeacon)\b|\b(?:https?|http2|net|tls)\s*\.\s*(?:request|get|connect)\s*\(|\brequire\s*\(\s*['"`](?:node:)?(?:https?|net|tls)['"`]\s*\)\s*\.\s*(?:request|get|connect)/;
const FILE_WRITE_RE = /\b(?:write(?:File(?:Sync)?)|append(?:File(?:Sync)?)|createWriteStream)\s*\(/;
// ... or one variable placed inside the address of a request (a query string), or handed to a request body write.
const ENV_IN_URL_RE = /https?:\/\/[^\s'"`]*(?:\$\{\s*process\.env|['"`]\s*\+\s*process\.env)/;
const ENV_IN_REQUEST_BODY_RE = /\.\s*(?:end|write)\s*\([^)]*process\.env/;

// C4 follow-up: shell scripts used to be read by the JavaScript rules, which do not match shell syntax, so `eval "$x"` passed. Three rules, kept narrow
// because shell is full of legitimate eval of a command substitution (eval "$(direnv hook bash)"): only a plain variable expansion counts.
const SHELL_EVAL_VAR_RE = /(?<![\w-])eval\s+[^#\n]*\$(?:\w|\{)/;
const SHELL_C_VAR_RE = /(?<![\w-])(?:ba|z|k)?sh\s+-c\s+[^#\n]*\$(?:\w|\{)/;
const SHELL_PIPE_TO_SHELL_RE = /\b(?:curl|wget)\b[^|#\n]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/;

const PYTHON_OS_SHELL_RE = /\bos\.(?:system|popen)\s*\(\s*(?:[fF][rR]?['"]|(?![rRbBuU]?['"])[A-Za-z_(])/;
const PYTHON_SHELL_TRUE_RE = /\bsubprocess\.\w+\s*\(.*\bshell\s*=\s*True/;
const PYTHON_EXEC_RE = /(?<![\w.])(?:exec|eval)\s*\(/;
// C4: exec( or eval( that sits inside a quoted string (a message, a docstring line) is text, not a call. Judged by quote parity before the match,
// one line at a time; a line that opens a triple-quoted string on an earlier line is not known to this rule and is still read as code.
function pythonExecOutsideString(line: string): boolean {
  const re = new RegExp(PYTHON_EXEC_RE.source, "g");
  for (let m = re.exec(line); m; m = re.exec(line)) {
    let single = 0, double = 0;
    for (let i = 0; i < m.index; i++) {
      const c = line[i];
      if (c === "\\") { i++; continue; }
      if (c === "'" && double % 2 === 0) single++;
      else if (c === '"' && single % 2 === 0) double++;
    }
    if (single % 2 === 0 && double % 2 === 0) return true;
  }
  return false;
}
const PYTHON_DYNAMIC_IMPORT_RE = /(?<![\w.])__import__\s*\(|\bimportlib\.import_module\s*\(\s*(?!['"])/;
const PYTHON_NETWORK_RE = /\b(?:urllib\.request\.urlopen|urlopen|requests\.(?:get|post|put|patch|request)|httpx\.\w+|http\.client\.\w+|aiohttp\.\w+|socket\.\w+)\s*\(/;
const PYTHON_BULK_ENV_RE = /\bos\.environ\b(?!\s*(?:\[|\.get\s*\())|\bdict\s*\(\s*os\.environ|\bos\.environ\.(?:items|copy)\s*\(/;
const PYTHON_ENV_IN_URL_RE = /https?:\/\/[^\s'"]*(?:\{\s*os\.environ|['"]\s*\+\s*os\.environ|%\s*os\.environ)/;

const PYTHON_SQL_INJECTION_RE = /\.execute\s*\(\s*(f['"].*\{|['"].*%|['"].*\+)/i;
const PYTHON_WEAK_CRYPTO_RE = /hashlib\.(md5|sha1)/i;
const PYTHON_UNSAFE_DESERIALIZATION_RE = /pickle\.loads|yaml\.load\b/i;

// F03-04 / C4: how a dependency name is compared with popular ones. Two lists and a threshold, all written from known packages; this is not
// a lookup of the registry. A name on POPULAR_REAL is never flagged (a real package that happens to sit near another one: next/jest,
// less/jest, jose/node, cypress/express, nest/jest, vite/vitest, tsup/tsx, chai/chalk, preact/react, dotenvx/dotenv). A name not on it
// is flagged when it is one edit (a letter added, dropped, changed, or two neighbours swapped) from a name in TOP_PACKAGES, or two edits
// for a name of 8 letters or more. Cost of this rule: a two-edit look-alike of a short name is no longer flagged, and a new look-alike
// of a package that is on neither list is not flagged at all.
const POPULAR_REAL = new Set([
  "next", "less", "jose", "cypress", "nest", "vite", "chai", "tsup", "preact", "dotenvx", "nanoid", "ora", "execa", "got", "ky", "vue", "koa", "pug",
  "esbuild", "rollup", "webpack", "parcel", "swc", "babel", "eslint", "prettier", "mocha", "jest", "vitest", "ava", "tape", "sinon", "nyc", "c8",
  "pino", "winston", "bunyan", "yargs", "meow", "cac", "inquirer", "prompts", "ink", "ws", "pg", "mysql", "mysql2", "knex", "prisma", "redis", "ioredis",
  "mongoose", "mongodb", "sequelize", "typeorm", "bull", "bullmq", "fastify", "hono", "nuxt", "svelte", "solid-js", "astro", "remix", "gatsby",
  "react-dom", "react-router", "redux", "zustand", "mobx", "rxjs", "ramda", "underscore", "dayjs", "moment", "date-fns", "luxon", "axios",
  "node-fetch", "undici", "superagent", "request", "cors", "helmet", "morgan", "multer", "passport", "jsonwebtoken", "bcrypt", "bcryptjs",
  "argon2", "yup", "joi", "ajv", "tslib", "ts-node", "nodemon", "concurrently", "rimraf", "cross-env", "glob", "chokidar", "cheerio", "jsdom",
  "puppeteer", "playwright", "husky", "lint-staged", "sass", "postcss", "tailwindcss", "ejs", "handlebars", "mustache", "marked", "uuid", "debug",
  "dotenv", "chalk", "tsx", "turbo", "commander", "lodash", "express", "react", "typescript", "zod", "zx", "pnpm", "yarn", "npm",
]);
const TOP_PACKAGES = [
  "lodash", "express", "react", "commander", "typescript", "axios", "debug", "uuid", "dotenv", "zod", "chalk", "tsx", "turbo", "node", "jest", "vitest", "mocha",
  "react-dom", "webpack", "eslint", "prettier", "moment", "request", "underscore", "bluebird", "async", "colors", "yargs", "mongoose", "socket.io",
];

// Optimal string alignment distance: an insert, a delete, a change, or two neighbouring letters swapped each count as one edit.
function levenshteinDistance(a: string, b: string): number {
  const d: number[][] = [];
  for (let i = 0; i <= a.length; i++) { d[i] = []; d[i]![0] = i; }
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

export const GOLDEN_CORPUS: { name: string; code: string; shouldBlock: boolean; severity: SecuritySeverity }[] = [
  {
    name: "Safe SQL query",
    code: 'db.prepare("SELECT * FROM users WHERE id = ?").get(id);',
    shouldBlock: false,
    severity: "Low",
  },
  {
    name: "SQL injection with string concat",
    code: 'db.query("SELECT * FROM users WHERE name = " + userInput);',
    shouldBlock: true,
    severity: "Critical",
  },
  {
    name: "Hardcoded secret",
    code: 'const apiKey = "AKIAIOSFODNN7EXAMPLE";',
    shouldBlock: true,
    severity: "Critical",
  },
  {
    name: "Weak crypto MD5",
    code: 'const hash = crypto.createHash("md5").update(data).digest("hex");',
    shouldBlock: true,
    severity: "High",
  },
];

// A7-1: how a long line is read. Several rules above backtrack, so their cost grows with the square of a line's length (600 KB
// of `exec(` took 43 s, measured; the repository lock lasts 30 s). A line longer than LINE_WINDOW is read in windows that
// overlap, so cost grows with the length. A pattern longer than the overlap that straddles a window edge can be missed, which
// is the same limit every line-based rule here already has. A line past LINE_SCAN_CAP is read only up to the cap, and the
// result says so: a part that was not read must never look like a part that was clean.
const LINE_WINDOW = 2048;
const LINE_WINDOW_OVERLAP = 256;
const LINE_SCAN_CAP = 1024 * 1024;

let invocationSecurityOverride: string | undefined = undefined;

export function setSecurityOverride(reason?: string): void {
  invocationSecurityOverride = reason;
}

/** One file as the gate reads it. `base` is what the file held before this change; absent for a new file or when it could not be read. */
export interface SecurityGateFile {
  path: string;
  content: string;
  base?: string;
}

// F03-05: documentation and plain text are not code, so the code rules (written for JavaScript) do not read them: an example
// call in a README is not a call. Secrets are still scanned in every file. Any other type, including one with no rules, is read
// as before: an unknown type must not become a way around the gate.
const PROSE_FILE_RE = /\.(?:md|markdown|mdx|txt|rst|adoc)$/i;
// C4: data and configuration files have no code for the code rules to read: a string in a JSON or YAML file that mentions exec( is text. Secrets
// are still scanned in them, and package.json is still read as a manifest below.
const DATA_FILE_RE = /\.(?:json|jsonc|json5|ya?ml|toml|ini|cfg|csv|tsv|lock)$/i;
const PYTHON_FILE_RE = /\.pyi?$/i;
const SHELL_FILE_RE = /\.(?:sh|bash|zsh|ksh)$/i;
// R1-d: types the code rules have no rules for. They are still read with the JavaScript rules (HTML carries inline scripts, and an unknown
// type must not become a way around the gate), but a clean result there proves little, so each is listed as read with JavaScript rules only.
// Secrets are scanned in every file as before. An extension not named here falls to "other" and is read as before, without a note.
const NO_RULES_FILE_RE = /(?:\.(?:go|rs|rb|php|html?|mk)$|(?:^|[\\/])makefile$)/i;

type FileClass = "prose" | "data" | "python" | "shell" | "norules" | "other";
function fileClass(path: string): FileClass {
  if (PROSE_FILE_RE.test(path)) return "prose";
  if (DATA_FILE_RE.test(path)) return "data";
  if (PYTHON_FILE_RE.test(path)) return "python";
  if (SHELL_FILE_RE.test(path)) return "shell";
  if (NO_RULES_FILE_RE.test(path)) return "norules";
  // JavaScript and TypeScript, and every type with no rules of its own: an unknown type must not become a way around the gate, so the
  // JavaScript rules read it as before.
  return "other";
}

function collectAll(files: { path: string; content: string }[]): { findings: SecurityFindingItem[]; notRead: { path: string; reason: string }[] } {
  const findings: SecurityFindingItem[] = [];
  const notRead: { path: string; reason: string }[] = [];

  // 1. Secret scan (reusing security/secrets.ts) — always Critical
  const secretFindings = scanForSecrets(files);
  for (const sf of secretFindings) {
    findings.push({
      path: sf.path,
      line: sf.line,
      category: "Hardcoded Secret",
      severity: "Critical",
      message: `Hardcoded secret detected (${sf.reason}): ${sf.match}`,
    });
  }

  // 2. Pattern-based code checks
  for (const file of files) {
    const cls = fileClass(file.path);
    const isManifest = file.path.endsWith("package.json");
    if ((cls === "prose" || cls === "data") && !isManifest) {
      notRead.push({ path: file.path, reason: cls === "prose" ? "documentation or plain text" : "data or configuration file" });
    }
    if (cls === "norules") {
      notRead.push({ path: file.path, reason: "no code rules for this file type; read with the JavaScript rules only, so a clean result is weaker here" });
    }
    const lines = cls === "prose" || cls === "data" ? [] : file.content.split("\n");
    const scanLine = (line: string, lineNo: number): void => {
      // C4: a Python file is read by the Python rules below only; the JavaScript rules would read its strings and comments as code.
      if (cls !== "python" && cls !== "shell") {
        if (SQL_INJECTION_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "SQL Injection",
            severity: "Critical",
            message: `Potential SQL injection via string concatenation or template interpolation.`,
          });
        }

        if (COMMAND_INJECTION_RE.test(line) && !line.includes("process.execPath")) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Command/Code Injection",
            severity: "Critical",
            message: `Potential command or code injection pattern.`,
          });
        }

        const notExecPath = !line.includes("process.execPath");
        if (notExecPath && (SHELL_CALL_NON_LITERAL_RE.test(line) || SPAWN_BY_NAME_RE.test(line) || SPAWN_SHELL_OPTION_RE.test(line))) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Command/Code Injection",
            severity: "Critical",
            message: `A shell command is built from a variable, run through a shell option, or reached by name in brackets. Review where its input comes from.`,
          });
        }

        if (DYNAMIC_FUNCTION_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Unsafe Deserialization / Evaluation",
            severity: "High",
            message: `Code is built from text at run time (new Function, vm.run...), which has the same risk as eval.`,
          });
        }

        const bulkEnv = BULK_ENV_RE.test(line);
        const networkCall = NETWORK_CALL_RE.test(line);
        if ((networkCall && (bulkEnv || ENV_IN_URL_RE.test(line))) || ENV_IN_REQUEST_BODY_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Secret Exfiltration",
            severity: "Critical",
            message: `Environment values are sent over the network (the whole environment, a value placed in the address, or a request body). Review where they go.`,
          });
        }
        if (bulkEnv && FILE_WRITE_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Secret Exfiltration",
            severity: "High",
            message: `The whole environment is written to a file, which would store every secret in it.`,
          });
        }

        if (WEAK_CRYPTO_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Weak Cryptography",
            severity: "High",
            message: `Use of known-weak cryptographic primitive (MD5/SHA1 or legacy cipher).`,
          });
        }

        if (UNSAFE_DESERIALIZATION_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Unsafe Deserialization / Evaluation",
            severity: "High",
            message: `Use of unsafe evaluation or deserialization method.`,
          });
        }

      }

      if (cls === "shell") {
        // A comment is not a command: drop a whole-line comment, or a trailing one that follows whitespace (so $# and ${#x} are kept).
        const code = line.replace(/(^|\s)#.*$/, "$1");
        if (SHELL_EVAL_VAR_RE.test(code) || SHELL_C_VAR_RE.test(code)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Command/Code Injection",
            severity: "Critical",
            message: `A shell script runs text held in a variable (eval or sh -c with $VAR). Review where its value comes from.`,
          });
        }
        if (SHELL_PIPE_TO_SHELL_RE.test(code)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Command/Code Injection",
            severity: "High",
            message: `A script downloaded with curl or wget is piped straight into a shell, so whatever the server sends is run.`,
          });
        }
      }

      if (cls === "python") {
        if (PYTHON_SQL_INJECTION_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "SQL Injection",
            severity: "Critical",
            message: `Potential Python SQL injection via string formatting or concatenation.`,
          });
        }
        if (PYTHON_OS_SHELL_RE.test(line) || PYTHON_SHELL_TRUE_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Command/Code Injection",
            severity: "Critical",
            message: `A Python shell command built from a variable or f-string, or subprocess with shell=True. Review where its input comes from.`,
          });
        }
        if (pythonExecOutsideString(line) || PYTHON_DYNAMIC_IMPORT_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Unsafe Deserialization / Evaluation",
            severity: "High",
            message: `Python runs code or loads a module chosen at run time (exec, __import__, importlib with a variable).`,
          });
        }
        if (PYTHON_NETWORK_RE.test(line) && (PYTHON_BULK_ENV_RE.test(line) || PYTHON_ENV_IN_URL_RE.test(line))) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Secret Exfiltration",
            severity: "Critical",
            message: `Environment values are sent over the network (the whole environment, or a value placed in the address).`,
          });
        }
        if (PYTHON_WEAK_CRYPTO_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Weak Cryptography",
            severity: "High",
            message: `Use of known-weak Python cryptographic primitive (hashlib.md5/sha1).`,
          });
        }
        if (PYTHON_UNSAFE_DESERIALIZATION_RE.test(line)) {
          findings.push({
            path: file.path,
            line: lineNo,
            category: "Unsafe Deserialization / Evaluation",
            severity: "High",
            message: `Use of unsafe Python deserialization (pickle.loads/yaml.load).`,
          });
        }
      }
    };
    lines.forEach((fullLine, idx) => {
      const lineNo = idx + 1;
      if (fullLine.length <= LINE_WINDOW) {
        scanLine(fullLine, lineNo);
        return;
      }
      const first = findings.length;
      const readUpTo = Math.min(fullLine.length, LINE_SCAN_CAP);
      for (let at = 0; at < readUpTo; at += LINE_WINDOW - LINE_WINDOW_OVERLAP) {
        scanLine(fullLine.slice(at, Math.min(at + LINE_WINDOW, readUpTo)), lineNo);
        if (at + LINE_WINDOW >= readUpTo) break;
      }
      // Windows overlap, so one pattern can be seen twice: keep one finding per kind for this line.
      const seen = new Set<string>();
      const kept = findings.splice(first).filter((f) => {
        const key = `${f.category}|${f.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      findings.push(...kept);
      if (fullLine.length > LINE_SCAN_CAP) {
        findings.push({
          path: file.path,
          line: lineNo,
          category: "Scan Limit",
          severity: "Medium",
          message: `This line is ${fullLine.length} characters long. Only the first ${LINE_SCAN_CAP} were scanned; the rest was not scanned.`,
        });
      }
    });

    // 3. Dependency / Manifest checks (package.json)
    if (file.path.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(file.content);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const depName of Object.keys(allDeps)) {
          // Typosquat check
          if (POPULAR_REAL.has(depName) || depName.startsWith("@")) continue;
          for (const topPkg of TOP_PACKAGES) {
            if (depName !== topPkg) {
              const dist = levenshteinDistance(depName, topPkg);
              if (dist > 0 && dist <= (depName.length >= 8 ? 2 : 1) && depName.length >= 4) {
                findings.push({
                  path: file.path,
                  line: 1,
                  category: "Typosquatting Risk",
                  severity: "High",
                  message: `Dependency "${depName}" is suspiciously close to popular package "${topPkg}" (edit distance ${dist}). This compares the name with a short built-in list; it is not a registry lookup, so check the package is the one you mean.`,
                });
              }
            }
          }
        }
      } catch {
        // A10: this used to be skipped silently, so an unreadable manifest read as a clean dependency check. Say it was not checked.
        // Medium, like the over-long-line finding above: it does not block, it only stops the silence.
        findings.push({
          path: file.path,
          line: 1,
          category: "Scan Limit",
          severity: "Medium",
          message: "This package.json is not valid JSON, so its dependencies were not checked.",
        });
      }
    }
  }

  return { findings, notRead };
}

function collectFindings(files: { path: string; content: string }[]): SecurityFindingItem[] {
  return collectAll(files).findings;
}

// Findings of these kinds are never forgiven as old: a secret in a file stays a secret, and a limit says something was not read.
const NEVER_PRE_EXISTING = new Set(["Hardcoded Secret", "Scan Limit"]);

function findingKey(f: SecurityFindingItem, content: string): string {
  const text = (content.split("\n")[f.line - 1] ?? "").replace(/\s+/g, " ").trim();
  return `${f.category}|${f.message}|${text}`;
}

/**
 * F03-05: a finding the file already had before the change is advisory (Low, "Pre-existing, not blocking"); only a finding the
 * change introduces keeps its severity. Findings are matched by kind and line text with whitespace collapsed, one for one, so a
 * moved or re-indented line is still the old finding, a changed line is a new one, and a second copy is new.
 */
function demotePreExisting(files: SecurityGateFile[], findings: SecurityFindingItem[]): SecurityFindingItem[] {
  const byPath = new Map<string, SecurityGateFile[]>();
  for (const f of files) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
  const allowance = new Map<string, Map<string, number>>();
  for (const f of files) {
    if (typeof f.base !== "string") continue;
    const counts = allowance.get(f.path) ?? new Map<string, number>();
    for (const old of collectFindings([{ path: f.path, content: f.base }])) {
      if (NEVER_PRE_EXISTING.has(old.category)) continue;
      const key = findingKey(old, f.base);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    allowance.set(f.path, counts);
  }
  return findings.map((finding) => {
    if (NEVER_PRE_EXISTING.has(finding.category)) return finding;
    const counts = allowance.get(finding.path);
    const content = byPath.get(finding.path)?.[0]?.content;
    if (!counts || content === undefined) return finding;
    const key = findingKey(finding, content);
    const left = counts.get(key) ?? 0;
    if (left <= 0) return finding;
    counts.set(key, left - 1);
    return { ...finding, severity: "Low" as const, message: `Pre-existing, not blocking: ${finding.message}` };
  });
}

/** What an advisory source says about one (ecosystem, name, version): the advisory ids it knows. An empty `ids` list means checked, none known. */
export interface DepAdvisory {
  ecosystem: string;
  name: string;
  version: string;
  ids: string[];
}

/** F03-03: a cooldown window for a name first published very recently (research 03, 3.1: pnpm's default is 1 day, most malicious packages are classified within 3, so 7 is the chosen default). */
export const NEW_PACKAGE_COOLDOWN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SecurityGateOptions {
  /**
   * F03-03: what a registry said about the NAMES this change adds (exists or not, first-publish date). Synchronous, answered from a cache
   * the caller filled before verification (security/dep_lookup.ts). A name with no verdict is reported as "existence not checked".
   * Left out, no existence check is reported at all (the lookup is off, which is the default).
   */
  registryLookup?: (pairs: DepPair[]) => RegistryVerdict[];
  /** Clock for the cooldown window, so a test can fix it. Defaults to Date.now(). */
  now?: () => number;
  /**
   * F03-02: a source of known-vulnerability data for exact (name, version) pairs. It must answer on the synchronous path (a local
   * database or a cache). Returning undefined, or throwing, means "could not look up": those pairs are reported as not checked, never
   * as clean. With no source configured every pair is reported as not checked. The OSV lookup (security/dep_lookup.ts) fills such a cache before the gate runs when PURIX_DEP_LOOKUP is set; it is off by default (D-q, docs/DECISIONS-2026-11-12.md), and the gate itself never touches the network (ADR-009).
   */
  advisoryLookup?: (pairs: DepPair[]) => DepAdvisory[] | undefined;
}

const SHOWN_PAIRS = 5;
function listPairs(pairs: DepPair[]): string {
  const shown = pairs.slice(0, SHOWN_PAIRS).map((p) => `${p.name}@${p.version ?? p.spec}`).join(", ");
  return pairs.length > SHOWN_PAIRS ? `${shown} and ${pairs.length - SHOWN_PAIRS} more` : shown;
}

/**
 * F03-03: does each name this change adds exist, and was it first published inside the cooldown window? Report-only (D-r): a name that
 * does not exist cannot be installed today, but anyone can register it later, which is the slopsquatting case. With the lookup off
 * (no `registryLookup`) nothing is added here, so the result is the same as before this existed. With it on, a name the registry did not
 * answer for is listed as "existence not checked", never as fine.
 */
function registryFindings(path: string, pairs: DepPair[], options: SecurityGateOptions): SecurityFindingItem[] {
  if (!options.registryLookup) return [];
  const names = pairs.filter((p) => isRegistrySpec(p.spec));
  if (names.length === 0) return [];
  let verdicts: RegistryVerdict[];
  try {
    verdicts = options.registryLookup(names);
  } catch {
    verdicts = [];
  }
  const byName = new Map(verdicts.map((v) => [`${v.ecosystem}\0${v.name}`, v]));
  const now = (options.now ?? Date.now)();
  const out: SecurityFindingItem[] = [];
  const unanswered: DepPair[] = [];
  const seen = new Set<string>();
  for (const p of names) {
    const key = `${p.ecosystem}\0${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = byName.get(key);
    if (!v) {
      unanswered.push(p);
      continue;
    }
    if (v.state === "missing") {
      out.push({
        path,
        line: 1,
        category: "Dependency Not Found",
        severity: "Medium",
        message: `This change adds ${p.name}, but ${v.host} has no package with that name. A name that does not exist can be registered later by someone else; a name an AI tool made up is the usual cause. Check the spelling before installing.`,
      });
    } else if (v.created !== undefined) {
      const ageMs = now - Date.parse(v.created);
      if (ageMs >= 0 && ageMs < NEW_PACKAGE_COOLDOWN_DAYS * DAY_MS) {
        const days = Math.floor(ageMs / DAY_MS);
        out.push({
          path,
          line: 1,
          category: "New Package",
          severity: "Medium",
          message: `This change adds ${p.name}, first published ${days === 0 ? "less than a day" : `${days} day${days === 1 ? "" : "s"}`} ago (${v.host}), inside the ${NEW_PACKAGE_COOLDOWN_DAYS}-day cooldown. Most malicious packages are found within 3 days of publication.`,
        });
      }
    }
  }
  if (unanswered.length > 0) {
    out.push({
      path,
      line: 1,
      category: "Dependency Check",
      severity: "Medium",
      message: `Whether ${unanswered.length} added name${unanswered.length === 1 ? " exists" : "s exist"}, and when ${unanswered.length === 1 ? "it was" : "they were"} first published, was not checked (the registry did not answer or could not be asked): ${listPairs(unanswered)}.`,
    });
  }
  return out;
}

/**
 * F03-02: the dependencies this change added or raised, and what is known about them. Only the change is looked at, not the whole old
 * tree. A pair with an exact version goes to the advisory source when there is one; a version range, a non-registry source, a failed
 * lookup and a missing source are all reported as "not checked", because none of them is a clean result. Never blocks: a known
 * advisory is reported with its ids so a person decides; blocking on one is a policy choice nobody has made.
 */
function dependencyFindings(files: SecurityGateFile[], options: SecurityGateOptions): SecurityFindingItem[] {
  const out: SecurityFindingItem[] = [];
  for (const file of files) {
    const delta = manifestDelta(file.path, file.base, file.content);
    if (delta.unreadable) {
      // An unreadable package.json already has its own "Scan Limit" finding (above) that says its dependencies were not checked.
      if (/(^|[\\/])package\.json$/i.test(file.path)) continue;
      out.push({
        path: file.path,
        line: 1,
        category: "Dependency Check",
        severity: "Medium",
        message: `${file.path} could not be read, so the dependencies this change adds were not checked.`,
      });
      continue;
    }
    // A git, URL or path source in package.json is already judged (and blocked or noted) as "Dependency Source" by gates/manifest_delta.ts;
    // naming it again as "not checked" would report one dependency twice.
    const judgedElsewhere = (p: DepPair): boolean => p.ecosystem === "npm" && /(^|[\\/])package\.json$/i.test(file.path) && nonRegistryKind(p.spec) !== undefined;
    const pairs = delta.pairs.filter((p) => !judgedElsewhere(p));
    if (pairs.length === 0) continue;
    const exact = pairs.filter((p) => p.version !== undefined);
    const unversioned = pairs.filter((p) => p.version === undefined);
    let answered: DepAdvisory[] | undefined;
    if (exact.length > 0 && options.advisoryLookup) {
      try {
        answered = options.advisoryLookup(exact);
      } catch {
        answered = undefined;
      }
    }
    const notChecked: DepPair[] = [...unversioned];
    if (answered === undefined) notChecked.push(...exact);
    if (answered !== undefined) {
      for (const a of answered) {
        if (a.ids.length === 0) continue;
        // D-r (docs/DECISIONS-2026-11-12.md): a known vulnerability is reported and never blocks; a malicious-package record (OSV `MAL-` id)
        // means the package itself is malware, there is no good reason to add it, so it blocks (and an audited override can lift it).
        const malicious = a.ids.filter((id) => id.startsWith("MAL-"));
        if (malicious.length > 0) {
          out.push({
            path: file.path,
            line: 1,
            category: "Malicious Package",
            severity: "High",
            message: `This change adds ${a.name}@${a.version}, which OSV lists as a malicious package (${malicious.slice(0, 3).join(", ")}${malicious.length > 3 ? ` and ${malicious.length - 3} more` : ""}). Do not install it.`,
          });
        }
        const vulnerable = a.ids.filter((id) => !id.startsWith("MAL-"));
        if (vulnerable.length === 0) continue;
        out.push({
          path: file.path,
          line: 1,
          category: "Known Vulnerability",
          severity: "Medium",
          message: `This change adds ${a.name}@${a.version}, which has ${vulnerable.length} known advisor${vulnerable.length === 1 ? "y" : "ies"}: ${vulnerable.slice(0, 5).join(", ")}${vulnerable.length > 5 ? ` and ${vulnerable.length - 5} more` : ""}.`,
        });
      }
    }
    // Names in a lockfile are mostly transitive; "does this name exist" is asked only about what a manifest adds.
    if (!isLockfile(file.path)) out.push(...registryFindings(file.path, delta.pairs, options));
    if (notChecked.length > 0) {
      const ranges = unversioned.length > 0 ? ` A version range or a non-registry source (${listPairs(unversioned)}) does not name the version that will be installed, so a manifest alone cannot be checked for it.` : "";
      const why = answered === undefined && exact.length > 0 ? (options.advisoryLookup ? "the advisory lookup did not answer" : "no advisory source is configured") : "";
      out.push({
        path: file.path,
        line: 1,
        category: "Dependency Check",
        severity: "Medium",
        message:
          `This change adds or changes ${notChecked.length} dependenc${notChecked.length === 1 ? "y that was" : "ies that were"} not checked for known vulnerabilities: ${listPairs(notChecked)}.` +
          (why ? ` (${why}).` : "") +
          ranges,
      });
    }
  }
  return out;
}

export function runSecurityGate(
  files: SecurityGateFile[],
  overrideReasonParam?: string,
  options: SecurityGateOptions = {}
): SecurityGateResult {
  const collected = collectAll(files);
  // Dependency findings are never forgiven as old: they describe this change's own additions, and they never block.
  const findings = [...demotePreExisting(files, collected.findings), ...dependencyFindings(files, options)];
  // F03-02 / F03-03 (first part): what the change did to a manifest or .npmrc, judged against `base`. About this change, so never demoted as old.
  // Blocking rules live in gates/manifest_delta.ts (non-registry source, install script, registry change); the "not checked" advisory for added
  // dependencies lives in dependencyFindings above, which also reads package-lock.json and requirements.txt and takes the advisory source.
  for (const file of files) {
    const delta = /(?:^|[\\/])package\.json$/.test(file.path) ? manifestDeltaFindings(file.content, file.base)
      : /(?:^|[\\/])\.npmrc$/.test(file.path) ? npmrcDeltaFindings(file.content, file.base)
      : [];
    for (const d of delta) findings.push({ path: file.path, line: d.line, category: d.category, severity: d.severity, message: d.message });
  }
  // F03-02 remainder: a lockfile is judged against its base too (source, host, integrity). Never demoted as old: it describes this change.
  for (const file of files) {
    for (const d of lockDeltaFindings(file.path, file.content, file.base)) findings.push({ path: file.path, line: d.line, category: d.category, severity: d.severity, message: d.message });
  }

  const blockingFindings = findings.filter((f) => f.severity === "Critical" || f.severity === "High");
  let blocked = blockingFindings.length > 0;
  let reason = blocked
    ? `Security gate blocked changes due to ${blockingFindings.length} Critical/High severity finding(s): ${blockingFindings.map((f) => `${f.category} in ${f.path}:${f.line}`).join(", ")}`
    : undefined;

  const activeOverride = overrideReasonParam !== undefined ? overrideReasonParam : invocationSecurityOverride;
  if (blocked && activeOverride !== undefined) {
    const overrideReason = activeOverride;
    invocationSecurityOverride = undefined;
    recordOverrideAudit("SecurityGate", overrideReason, reason ?? "Critical/High security finding");
    console.log(`  [override] SecurityGate overridden: ${overrideReason.trim()}`);
    blocked = false;
    reason = undefined;
  }

  return {
    ok: !blocked,
    findings,
    advisories: findings.filter((f) => f.severity === "Low" || f.severity === "Medium"),
    notRead: collected.notRead,
    blocked,
    reason,
  };
}

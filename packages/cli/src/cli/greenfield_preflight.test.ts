// IDEA-090: what `create` settles before it calls the model or writes anything.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import {
  checkPlanPrerequisites,
  findNodeUsage,
  nodeTypesInstalled,
  runGreenfieldPreflight,
  type PreflightDeps,
  type PreflightIO,
} from "./greenfield_preflight.js";

interface Harness {
  io: PreflightIO;
  lines: string[];
  asked: string[];
  deps: PreflightDeps;
  saved: string[];
  installs: string[];
}

function harness(opts: {
  interactive?: boolean;
  answers?: (string | null)[];
  provider?: ReturnType<PreflightDeps["providerStatus"]>;
  configured?: string;
  detected?: string[];
  allowed?: Record<string, boolean>;
  missing?: { id: string; version: string }[];
  install?: Awaited<ReturnType<PreflightDeps["installTool"]>>;
}): Harness {
  const lines: string[] = [];
  const asked: string[] = [];
  const saved: string[] = [];
  const installs: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const allowed = { typescript: true, python: false, ...(opts.allowed ?? {}) };
  return {
    lines,
    asked,
    saved,
    installs,
    io: {
      interactive: opts.interactive ?? false,
      ask: async (q) => {
        asked.push(q);
        return answers.length > 0 ? answers.shift()! : null;
      },
      log: (l) => lines.push(l),
    },
    deps: {
      providerStatus: () => opts.provider ?? { ok: true },
      configuredLanguage: () => opts.configured,
      detectLanguages: () => opts.detected ?? [],
      languages: () => Object.entries(allowed).map(([id, ok]) => ({ id, allowed: ok })),
      saveLanguage: (_dir, id) => void saved.push(id),
      missingTypeCheckers: () => opts.missing ?? [],
      installTool: async (_dir, id) => {
        installs.push(id);
        return opts.install ?? { ok: true };
      },
    },
  };
}

describe("greenfield preflight: provider first", () => {
  it("stops on a missing provider before it asks about language or tools", async () => {
    const h = harness({ interactive: true, provider: { ok: false, message: "No API key found for your provider." }, missing: [{ id: "typescript", version: "5.7.2" }] });
    const r = await runGreenfieldPreflight("/x", h.io, h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Nothing was sent to the model and nothing was written.");
    expect(h.asked).toEqual([]);
    expect(h.installs).toEqual([]);
  });
});

describe("greenfield preflight: language", () => {
  it("uses the language set in config without asking", async () => {
    const h = harness({ configured: "python", interactive: true });
    expect(await runGreenfieldPreflight("/x", h.io, h.deps)).toEqual({ ok: true, language: "python" });
    expect(h.asked).toEqual([]);
  });

  it("follows the one language the folder already has, and says so", async () => {
    const h = harness({ detected: ["typescript"] });
    expect(await runGreenfieldPreflight("/x", h.io, h.deps)).toEqual({ ok: true, language: "typescript" });
    expect(h.lines.join("\n")).toContain("Using TypeScript");
  });

  it("does not guess in an empty folder when nobody can answer, and names the exact commands", async () => {
    const h = harness({ interactive: false });
    const r = await runGreenfieldPreflight("/x", h.io, h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("no project files yet");
      expect(r.message).toContain("purix config set language typescript");
      expect(r.message).toContain("purix config set language python");
    }
    expect(h.saved).toEqual([]);
  });

  it("asks at a terminal, saves the answer, and carries on", async () => {
    const h = harness({ interactive: true, answers: ["1"] });
    expect(await runGreenfieldPreflight("/x", h.io, h.deps)).toEqual({ ok: true, language: "typescript" });
    expect(h.saved).toEqual(["typescript"]);
    expect(h.lines.join("\n")).toContain("Which language should this project use?");
  });

  it("marks a language the tier cannot use, and refuses it without saving", async () => {
    const h = harness({ interactive: true, answers: ["2"] });
    const r = await runGreenfieldPreflight("/x", h.io, h.deps);
    expect(h.lines.join("\n")).toContain("Python (not available on this install)");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("not available");
    expect(h.saved).toEqual([]);
  });

  it("treats Enter, a wrong number and no input as cancelling", async () => {
    for (const answer of ["", "9", "abc", null]) {
      const h = harness({ interactive: true, answers: [answer] });
      const r = await runGreenfieldPreflight("/x", h.io, h.deps);
      expect(r.ok).toBe(false);
      expect(h.saved).toEqual([]);
    }
  });

  it("when two languages are present, asks between those two only", async () => {
    const h = harness({ interactive: true, detected: ["typescript", "python"], allowed: { python: true }, answers: ["2"] });
    expect(await runGreenfieldPreflight("/x", h.io, h.deps)).toEqual({ ok: true, language: "python" });
    expect(h.lines.join("\n")).toContain("more than one language");
  });
});

describe("greenfield preflight: the type checker", () => {
  const missing = [{ id: "typescript", version: "5.7.2" }];

  it("with nobody at the keyboard, names the install command and installs nothing", async () => {
    const h = harness({ configured: "typescript", missing });
    const r = await runGreenfieldPreflight("/x", h.io, h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("purix tools install typescript");
      expect(r.message).toContain("Nothing was sent to the model");
    }
    expect(h.installs).toEqual([]);
  });

  it("at a terminal, hands the install to the broker (which asks) and carries on", async () => {
    const h = harness({ configured: "typescript", missing, interactive: true });
    expect(await runGreenfieldPreflight("/x", h.io, h.deps)).toEqual({ ok: true, language: "typescript" });
    expect(h.installs).toEqual(["typescript"]);
  });

  it("a declined or failed install stops the run and keeps the broker's hint", async () => {
    const h = harness({ configured: "typescript", missing, interactive: true, install: { ok: false, message: "Install declined.", hint: "Nothing was installed." } });
    const r = await runGreenfieldPreflight("/x", h.io, h.deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("Install declined.");
      expect(r.message).toContain("Nothing was installed.");
      expect(r.message).toContain("purix tools install typescript");
    }
  });

  it("does nothing when the checker is already present", async () => {
    const h = harness({ configured: "typescript", interactive: true });
    expect(await runGreenfieldPreflight("/x", h.io, h.deps)).toEqual({ ok: true, language: "typescript" });
    expect(h.installs).toEqual([]);
  });
});

describe("plan prerequisites: files that cannot be checked", () => {
  const testFile = { path: "src/a.test.ts", starter_content: 'import { describe } from "node:test";\nimport assert from "node:assert/strict";\n' };
  const plainFile = { path: "src/a.ts", starter_content: "export const a = 1;\n" };

  function folder(): string {
    return mkdtempSync(join(tmpdir(), "purix-prereq-"));
  }

  it("finds node: imports, bare built-in imports and Node globals; ignores the rest", () => {
    expect(findNodeUsage([plainFile])).toBeNull();
    expect(findNodeUsage([testFile])?.evidence).toBe('imports "node:test"');
    expect(findNodeUsage([{ path: "a.ts", starter_content: "import { readFileSync } from 'fs';" }])?.evidence).toBe('imports "fs"');
    expect(findNodeUsage([{ path: "a.ts", starter_content: "const x = process.env.HOME;" }])?.evidence).toBe("uses process.env");
    expect(findNodeUsage([{ path: "a.py", starter_content: "import node:test" }])).toBeNull();
  });

  it("blocks a TypeScript plan that needs @types/node when it is missing, before anything is written", () => {
    const dir = folder();
    try {
      const r = checkPlanPrerequisites("typescript", [plainFile, testFile], dir, dir);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).toContain('src/a.test.ts imports "node:test"');
        expect(r.message).toContain("Nothing was written.");
        expect(r.message).toContain("npm init -y");
        expect(r.message).toContain("npm install --save-dev @types/node");
      }
    } finally {
      safeRmSync(dir);
    }
  });

  it("does not tell someone with a package.json to run npm init, and follows their package manager", () => {
    const dir = folder();
    try {
      writeFileSync(join(dir, "package.json"), "{}");
      writeFileSync(join(dir, "pnpm-lock.yaml"), "");
      const r = checkPlanPrerequisites("typescript", [testFile], dir, dir);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message).not.toContain("npm init");
        expect(r.message).toContain("pnpm add --save-dev @types/node");
      }
    } finally {
      safeRmSync(dir);
    }
  });

  it("passes when @types/node is here or in a parent folder (a monorepo root)", () => {
    const root = folder();
    try {
      mkdirSync(join(root, "node_modules", "@types", "node"), { recursive: true });
      writeFileSync(join(root, "node_modules", "@types", "node", "package.json"), "{}");
      const child = join(root, "packages", "app");
      mkdirSync(child, { recursive: true });
      expect(nodeTypesInstalled(child)).toBe(true);
      expect(checkPlanPrerequisites("typescript", [testFile], child)).toEqual({ ok: true });
    } finally {
      safeRmSync(root);
    }
  });

  it("passes plans that do not touch Node, and languages it does not know about", () => {
    const dir = folder();
    try {
      expect(checkPlanPrerequisites("typescript", [plainFile], dir)).toEqual({ ok: true });
      expect(checkPlanPrerequisites("python", [testFile], dir)).toEqual({ ok: true });
    } finally {
      safeRmSync(dir);
    }
  });
});

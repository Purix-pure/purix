// src/entrypoints/scaffold.ts
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TopologyPlan, ManifestEntry } from "../manifest/schema.js";
import { CURRENT_SCHEMA_VERSION } from "../manifest/schema_migrations.js";
import { findUnsafePaths } from "../gates/path_guard.js";
import { scanForSecrets } from "../security/secrets.js";
import { verifyComponent } from "../verify/verify.js";
import { getLanguageProvider } from "../language/registry.js";

export async function writeScaffold(
  plan: TopologyPlan,
  targetDir: string = process.cwd()
): Promise<string[]> {
  // Path-traversal guard. plan.files[].path comes from an LLM's
  // TopologyPlan (Greenfield classification) — treat it the same as any
  // other untrusted-origin path: a "../" segment or an absolute path
  // here would otherwise write outside the repo the moment the loop
  // below runs. Checked before the existing collision check, and before
  // anything is written.
  const unsafe = findUnsafePaths(targetDir, plan.files.map((f) => f.path));
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing to scaffold — plan contains path(s) outside the target directory: ` +
        unsafe.map((u) => `"${u.path}" (${u.reason})`).join("; ")
    );
  }

  const targetPaths = plan.files.map((f) => join(targetDir, f.path));

  const collisions = targetPaths.filter((p) => existsSync(p));
  if (collisions.length > 0) {
    throw new Error(`Refusing to scaffold — file(s) already exist: ${collisions.join(", ")}`);
  }

  // writeScaffold used to have zero verification beyond the
  // path-traversal guard above before writing LLM-generated
  // starter_content to disk. "Checked compiles and has no secrets"
  // should be the honest minimum, not zero — same secrets-scan-before-
  // write discipline every other write path in the system follows.
  // Fails closed: nothing is written if this finds anything.
  const secretFindings = scanForSecrets(plan.files.map((f) => ({ path: f.path, content: f.starter_content })));
  if (secretFindings.length > 0) {
    throw new Error(
      `Secrets/entropy scan blocked scaffold — nothing was written:\n` +
        secretFindings.map((f) => `  ${f.path}:${f.line} — ${f.reason} (${f.match})`).join("\n")
    );
  }

  const writtenPaths: string[] = [];
  try {
    for (const file of plan.files) {
      const fullPath = join(targetDir, file.path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, file.starter_content, "utf-8");
      console.log(`  created: ${file.path}`);
      writtenPaths.push(fullPath);
    }
  } catch (err) {
    for (const p of writtenPaths) {
      if (existsSync(p)) rmSync(p);
    }
    throw err;
  }

  // This won't be a full sandbox pass — there's no prior committed
  // state to compare against and no existing tests to run yet for a
  // brand-new component — but a compile check against what was just
  // written is still the honest minimum beyond zero. Runs AFTER the
  // write (unlike the secrets scan above) because compiling requires
  // real files on disk with real imports resolvable between them; on
  // failure, roll back the same way the existing catch block above
  // already does for I/O errors.
  const lang = plan.files.length > 0 && plan.files[0]!.path.endsWith(".py") ? "python" : "typescript";
  const provider = getLanguageProvider(lang);
  const verification = provider ? provider.verify(writtenPaths, targetDir) : verifyComponent(writtenPaths, targetDir);
  if (verification.status !== "pass") {
    for (const p of writtenPaths) {
      if (existsSync(p)) rmSync(p);
    }
    throw new Error(`Scaffold failed verification, rolled back what was written: ${verification.reason}`);
  }

  return writtenPaths;
}

/**
 * Scaffolding only ever runs via the Instruction Path (Greenfield mode,
 * §3.3) — Diff Ingestion has no scaffold step, since an external diff
 * already targets existing files. So provenance here is always
 * source_type: "instruction". source_agent defaults to null (a human
 * typing a CLI command isn't an "upstream coding agent" in the §3.2
 * sense) — pass an explicit id if this ever runs behind something else.
 */
export function buildManifestEntry(plan: TopologyPlan, sourceAgent: string | null = null): ManifestEntry {
  return {
    component_id: plan.component_id,
    component_type: plan.component_type,
    current_version: 1,
    schema_version: CURRENT_SCHEMA_VERSION,
    parts: { tools: [], config: {} },
    files: plan.files.map((f) => f.path),
    depends_on: plan.depends_on,
    depended_on_by: [],
    version_history: [
      {
        version: 1,
        operation: "create",
        patch_ref: "initial-scaffold",
        contract_changed: false,
        timestamp: new Date().toISOString(),
        provenance: { source_type: "instruction", source_agent: sourceAgent },
      },
    ],
    verification_status: "pending",
    last_synced_hash: null,
  };
}
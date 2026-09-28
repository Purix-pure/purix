// src/llm/context/pack.ts
//
// The one place that decides what repository context an LLM prompt receives
// (ADR-059). Callers pass the raw instruction and the component's files; they get
// back ready-to-embed blocks. With defaults and no project context file, the
// files block is BYTE-IDENTICAL to what the prompts always sent, so existing
// behaviour only changes when a component is genuinely large or a project
// supplies its own context file.
import { focusFiles, legacyFilesBlock, type FocusResult, type SourceFile } from "./focus.js";
import { loadProjectContext, type ProjectContextResult } from "./project_context.js";
import { loadContextConfig, type ContextConfig } from "./config.js";

export interface ContextPack {
  filesBlock: string;
  /** "" when there is nothing to add; otherwise a complete framed block ending in "\n". */
  projectBlock: string;
  focus: FocusResult | null;
  project: ProjectContextResult | null;
  /** One human-readable line per notable decision, for the CLI to print. Empty in the common case. */
  notes: string[];
}

export interface BuildPackInput {
  instruction: string;
  files: SourceFile[];
  baseDir?: string;
  config?: ContextConfig;
}

function projectNotes(project: ProjectContextResult): string[] {
  if (project.block) {
    return [`[context] project notes from ${project.source} (${project.includedSections.length} section(s), ~${project.estTokens} est. tokens)`];
  }
  if (project.dropped && /^injection_marker|^file_too_large/.test(project.dropped)) {
    return [`[context] ignored ${project.source}: ${project.dropped} — continuing without project notes`];
  }
  return [];
}

/** Project notes alone — for prompts that carry no repository files (greenfield planning). */
export function buildProjectOnlyPack(baseDir?: string, config?: ContextConfig): { projectBlock: string; notes: string[] } {
  const cfg = config ?? loadContextConfig();
  if (!cfg.enabled) return { projectBlock: "", notes: [] };
  const project = loadProjectContext(baseDir ?? process.cwd(), cfg);
  return { projectBlock: project.block, notes: projectNotes(project) };
}

export function buildContextPack(input: BuildPackInput): ContextPack {
  const cfg = input.config ?? loadContextConfig();
  if (!cfg.enabled) {
    return { filesBlock: legacyFilesBlock(input.files), projectBlock: "", focus: null, project: null, notes: [] };
  }
  const focus = focusFiles(input.files, input.instruction, cfg.fullMaxTokens, cfg.focusedMaxTokens);
  const project = loadProjectContext(input.baseDir ?? process.cwd(), cfg);

  const notes: string[] = [];
  if (focus.mode === "focused") {
    notes.push(
      `[context] component is large — sending a focused view (~${focus.estTokens} est. tokens: ${focus.fullFiles} full, ` +
        `${focus.windowedFiles} partial, ${focus.omittedPaths.length} not shown)`
    );
  }
  notes.push(...projectNotes(project));
  return { filesBlock: focus.filesBlock, projectBlock: project.block, focus, project, notes };
}

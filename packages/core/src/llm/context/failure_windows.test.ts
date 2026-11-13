import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepairFilesBlock, HEAD_LINES } from "./failure_windows.js";
import { legacyFilesBlock } from "./focus.js";
import { estimateTokens } from "./tokens.js";
import { DEFAULT_CONTEXT_CONFIG } from "./config.js";

const cfg = { enabled: true, fullMaxTokens: DEFAULT_CONTEXT_CONFIG.fullMaxTokens, focusedMaxTokens: DEFAULT_CONTEXT_CONFIG.focusedMaxTokens };

function bigFile(lines: number, prefix = "line"): string {
  const out: string[] = ['import { a } from "./a.js";', 'import { b } from "./b.js";'];
  for (let i = 3; i <= lines; i++) out.push(`export const ${prefix}_${i} = ${i}; // padding so each line has a realistic length`);
  return out.join("\n");
}

test("below the full-view threshold the block is byte-identical to the legacy block", () => {
  const files = [{ path: "src/a.ts", content: "export const a = 1;\n" }, { path: "src/b.ts", content: "export const b = 2;\n" }];
  const view = buildRepairFilesBlock(files, [{ path: "src/a.ts", line: 1 }], cfg);
  assert.equal(view.filesBlock, legacyFilesBlock(files));
  assert.equal(view.mode, "full");
});

test("with the context policy off the block is the legacy block even for a huge component", () => {
  const files = [{ path: "src/big.ts", content: bigFile(6000) }];
  const view = buildRepairFilesBlock(files, [{ path: "src/big.ts", line: 3000 }], { ...cfg, enabled: false });
  assert.equal(view.filesBlock, legacyFilesBlock(files));
});

test("a 6,000-line component is cut to windows that stay under the focused budget", () => {
  const files = [{ path: "src/big.ts", content: bigFile(6000) }];
  assert.ok(estimateTokens(legacyFilesBlock(files)) > cfg.fullMaxTokens, "fixture must be over the threshold");
  const view = buildRepairFilesBlock(files, [{ path: "src/big.ts", line: 3000 }, { path: "src/big.ts", line: 4200 }], cfg);
  assert.equal(view.mode, "windowed");
  assert.ok(view.estTokens <= cfg.focusedMaxTokens, `estimated ${view.estTokens} tokens`);
  assert.ok(view.filesBlock.includes("export const line_3000 ="));
  assert.ok(view.filesBlock.includes("export const line_4200 ="));
  assert.ok(view.filesBlock.includes('import { a } from "./a.js";'), "the head of the file (imports) is kept");
  assert.ok(!view.filesBlock.includes("export const line_1500 ="), "lines far from any failure are left out");
  assert.ok(/lines \d+-\d+ omitted/.test(view.filesBlock));
  assert.ok(view.filesBlock.includes("Context budget notice"));
  assert.deepEqual(view.windowedPaths, ["src/big.ts"]);
});

test("the window is forty lines either side when it fits", () => {
  const files = [{ path: "src/big.ts", content: bigFile(6000) }];
  const view = buildRepairFilesBlock(files, [{ path: "src/big.ts", line: 3000 }], cfg);
  assert.ok(view.filesBlock.includes("export const line_2960 ="));
  assert.ok(view.filesBlock.includes("export const line_3040 ="));
  assert.ok(!view.filesBlock.includes("export const line_2958 ="));
  assert.ok(!view.filesBlock.includes("export const line_3042 ="));
  assert.ok(view.filesBlock.includes(`(partial view: ${HEAD_LINES + 81} of 6000 lines)`));
});

test("many locations shrink the window instead of blowing the budget", () => {
  const files = [{ path: "src/big.ts", content: bigFile(6000) }];
  const locations = Array.from({ length: 8 }, (_, i) => ({ path: "src/big.ts", line: 400 + i * 700 }));
  const view = buildRepairFilesBlock(files, locations, cfg);
  assert.ok(view.estTokens <= cfg.focusedMaxTokens, `estimated ${view.estTokens} tokens`);
  for (const l of locations) assert.ok(view.filesBlock.includes(`export const line_${l.line} =`), `line ${l.line} missing`);
});

test("a path as the verifier prints it (extra leading directories, backslashes) still finds the file", () => {
  const files = [{ path: "src/big.ts", content: bigFile(6000) }];
  const view = buildRepairFilesBlock(files, [{ path: "C:\\work\\proj\\src\\big.ts", line: 2500 }, { path: "./src/big.ts", line: 2600 }], cfg);
  assert.ok(view.filesBlock.includes("export const line_2500 ="));
  assert.ok(view.filesBlock.includes("export const line_2600 ="));
});

test("files the verifier did not point at go through the focused view and the total stays under budget", () => {
  const files = [
    { path: "src/big.ts", content: bigFile(6000) },
    { path: "src/other.ts", content: bigFile(4000, "other") },
  ];
  const view = buildRepairFilesBlock(files, [{ path: "src/big.ts", line: 3000 }], cfg, "other");
  assert.ok(view.filesBlock.includes("--- src/big.ts (partial view"));
  assert.ok(view.filesBlock.includes("src/other.ts"));
  assert.ok(view.estTokens <= cfg.focusedMaxTokens + 200, `estimated ${view.estTokens} tokens`);
  assert.ok(estimateTokens(legacyFilesBlock(files)) > view.estTokens * 3);
});

test("locations that match no file fall back to the focused view, never to the whole component", () => {
  const files = [{ path: "src/big.ts", content: bigFile(6000) }];
  const view = buildRepairFilesBlock(files, [{ path: "elsewhere/x.ts", line: 4 }, { path: "src/big.ts", line: 99999 }], cfg);
  assert.ok(view.estTokens <= cfg.focusedMaxTokens + 200);
});

test("when even the narrowest windows cannot fit, later locations are dropped and named", () => {
  const files = [{ path: "src/big.ts", content: bigFile(6000) }];
  const tiny = { ...cfg, focusedMaxTokens: 400, fullMaxTokens: 500 };
  const locations = Array.from({ length: 8 }, (_, i) => ({ path: "src/big.ts", line: 300 + i * 600 }));
  const view = buildRepairFilesBlock(files, locations, tiny);
  assert.ok(view.droppedLocationPaths.includes("src/big.ts"));
  assert.ok(view.estTokens <= tiny.focusedMaxTokens + 200, `estimated ${view.estTokens} tokens`);
  assert.ok(view.filesBlock.includes("Context budget notice"));
  assert.ok(view.filesBlock.includes("export const line_300 ="));
});

// src/check_render.test.ts
//
// The printed `purix check` report: a next step that several items share is printed once, not once per item.
import { describe, it } from "node:test";
import { expect } from "expect";
import type { CheckReport } from "@purix/core/entrypoints/check";
import { renderCheckReport } from "./cli/commands/check";

const ADOPT = 'Run "purix adopt" to bring these files under Purix so they are checked from now on.';

function report(): CheckReport {
  return {
    outcome: "skipped",
    exitCode: 0,
    strict: false,
    summary: "summary line",
    sections: [
      {
        id: "drift",
        title: "Edits made outside Purix",
        outcome: "skipped",
        items: ["a.md", "b.md", "c.md"].map((f) => ({ outcome: "skipped" as const, subject: f, message: "written by an agent (opencode); not governed by Purix, so Purix did not verify it", next: ADOPT })),
      },
    ],
  } as unknown as CheckReport;
}

describe("renderCheckReport", () => {
  it("prints a shared next step once, after the items", () => {
    const out = renderCheckReport(report());
    expect(out.split(ADOPT).length - 1).toBe(1);
    expect(out.indexOf("c.md")).toBeLessThan(out.indexOf(ADOPT));
    expect(out).toContain("     a.md: written by an agent (opencode)");
  });

  it("prints nothing extra for items without a next step", () => {
    const r = report();
    for (const i of r.sections[0]!.items) delete (i as { next?: string }).next;
    expect(renderCheckReport(r)).not.toContain("→");
  });
});

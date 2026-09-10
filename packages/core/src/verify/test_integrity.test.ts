// src/verify/test_integrity.test.ts
//
// checkTestIntegrity is pure (in-memory ts-morph parse, no filesystem, no
// DB), so unlike store_delete.test.ts there's no chdir/tmpdir setup here —
// the fixture pattern it extends is the *shape* of that file: a small
// factory for the input (makeEntry there, before/after file pairs here)
// plus one describe block per behavior, each asserting on the concrete
// finding reason rather than just flagged/not-flagged where that reason
// is part of the contract.
import { describe, it } from "node:test";
import { expect } from "expect";
import { checkTestIntegrity, isTestFilePath } from "./test_integrity";

const PATH = "src/example/thing.test.ts";

function makeFiles(path: string, content: string) {
  return [{ path, content }];
}

describe("checkTestIntegrity", () => {
  it("flags a dropped assertion count between before and after", () => {
    const before = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("does two things", () => {
  expect(1).toBe(1);
  expect(2).toBe(2);
});
`
    );
    const after = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("does two things", () => {
  expect(1).toBe(1);
});
`
    );

    const result = checkTestIntegrity(before, after);
    expect(result.flagged).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.path).toBe(PATH);
    expect(result.findings[0]!.reason).toMatch(/assertion count dropped from 2 to 1/);
  });

  it("flags a specific assertion target disappearing even when the count stays the same", () => {
    const before = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("checks both fields", () => {
  expect(user.name).toBe("a");
  expect(user.age).toBe(30);
});
`
    );
    // Count is still 2, but the check on user.age was swapped for a
    // duplicate check on user.name — the exact prior check disappeared.
    const after = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("checks both fields", () => {
  expect(user.name).toBe("a");
  expect(user.name).toBe("a");
});
`
    );

    const result = checkTestIntegrity(before, after);
    expect(result.flagged).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.reason).toMatch(/user\.age/);
    expect(result.findings[0]!.reason).toMatch(/no longer present/);
  });

  it("flags new it.skip / test.todo annotations appearing", () => {
    const before = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("runs", () => {
  expect(1).toBe(1);
});
it("also runs", () => {
  expect(2).toBe(2);
});
`
    );
    const after = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("runs", () => {
  expect(1).toBe(1);
});
it.skip("also runs", () => {
  expect(2).toBe(2);
});
`
    );

    const result = checkTestIntegrity(before, after);
    expect(result.flagged).toBe(true);
    expect(result.findings[0]!.reason).toMatch(/1 new skip\/todo annotation/);
  });

  it("flags new bare xit/xdescribe forms appearing, same as it.skip", () => {
    const before = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("runs", () => {
  expect(1).toBe(1);
});
`
    );
    const after = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
xit("runs", () => {
  expect(1).toBe(1);
});
`
    );

    const result = checkTestIntegrity(before, after);
    expect(result.flagged).toBe(true);
    expect(result.findings[0]!.reason).toMatch(/1 new skip\/todo annotation/);
  });

  it("flags test.todo appearing where there was a real test before", () => {
    const before = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("runs", () => {
  expect(1).toBe(1);
});
`
    );
    const after = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
test.todo("runs");
`
    );

    const result = checkTestIntegrity(before, after);
    expect(result.flagged).toBe(true);
    // Losing the assertion entirely takes priority (checked first), and
    // that's a legitimate flag on its own — either way this must flag.
    expect(result.findings).toHaveLength(1);
  });

  // NOTE on fixture choice: TypeScript's parser is deliberately permissive —
  // shallow garbage like "{{{ (((" still produces a valid (if empty) AST
  // rather than throwing, so it wouldn't actually exercise the catch block
  // in parseInMemory. Deep paren nesting is a real, reliable trigger for a
  // genuine parser exception (stack overflow during recursive descent),
  // which is what parseInMemory's try/catch is there to catch — so this is
  // what actually drives analyzeTestFile to return null instead of a
  // zero-assertion profile.
  const UNPARSEABLE = "(".repeat(200_000) + "1" + ")".repeat(200_000) + ";";

  it("flags a file that fails to parse as 'couldn't parse', not as zero-assertions-clean", () => {
    const before = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("runs", () => {
  expect(1).toBe(1);
});
`
    );
    const after = makeFiles(PATH, UNPARSEABLE);

    const result = checkTestIntegrity(before, after);
    expect(result.flagged).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.reason).toMatch(/couldn't parse/);
  });

  it("also flags when the *prior* version fails to parse, not just the new one", () => {
    const before = makeFiles(PATH, UNPARSEABLE);
    const after = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("runs", () => {
  expect(1).toBe(1);
});
`
    );

    const result = checkTestIntegrity(before, after);
    expect(result.flagged).toBe(true);
    expect(result.findings[0]!.reason).toMatch(/couldn't parse/);
  });

  it("does not flag an untouched file (identical before/after content)", () => {
    const content = `
import { it, expect } from "bun:test";
it("runs", () => {
  expect(1).toBe(1);
});
`;
    const result = checkTestIntegrity(makeFiles(PATH, content), makeFiles(PATH, content));
    expect(result.flagged).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag a newly-added test file with no prior version", () => {
    const after = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("is brand new", () => {
  expect(1).toBe(1);
});
`
    );

    const result = checkTestIntegrity([], after);
    expect(result.flagged).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it("does not flag when assertions increase and no targets are removed", () => {
    const before = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("runs", () => {
  expect(1).toBe(1);
});
`
    );
    const after = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("runs", () => {
  expect(1).toBe(1);
  expect(2).toBe(2);
});
`
    );

    const result = checkTestIntegrity(before, after);
    expect(result.flagged).toBe(false);
  });

  it("does not flag a file present in before but absent from after (out of scope for this check)", () => {
    const before = makeFiles(
      PATH,
      `
import { it, expect } from "bun:test";
it("runs", () => {
  expect(1).toBe(1);
});
`
    );
    // after has no entry for PATH at all — checkTestIntegrity only walks
    // `after`, so a wholesale file deletion isn't this function's job.
    const result = checkTestIntegrity(before, []);
    expect(result.flagged).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  it("only evaluates files present in the after list, ignoring unrelated before-only files", () => {
    const before = [
      { path: PATH, content: `import { it, expect } from "bun:test";\nit("a", () => { expect(1).toBe(1); expect(2).toBe(2); });\n` },
      { path: "src/other/thing.test.ts", content: `import { it, expect } from "bun:test";\nit("b", () => { expect(3).toBe(3); });\n` },
    ];
    const after = [
      { path: PATH, content: `import { it, expect } from "bun:test";\nit("a", () => { expect(1).toBe(1); expect(2).toBe(2); });\n` },
    ];

    const result = checkTestIntegrity(before, after);
    expect(result.flagged).toBe(false);
  });

  it("reports one finding per offending file across multiple files", () => {
    const before = [
      { path: "src/a/a.test.ts", content: `import { it, expect } from "bun:test";\nit("a", () => { expect(1).toBe(1); expect(2).toBe(2); });\n` },
      { path: "src/b/b.test.ts", content: `import { it, expect } from "bun:test";\nit("b", () => { expect(3).toBe(3); });\n` },
    ];
    const after = [
      { path: "src/a/a.test.ts", content: `import { it, expect } from "bun:test";\nit("a", () => { expect(1).toBe(1); });\n` },
      { path: "src/b/b.test.ts", content: `import { it, expect } from "bun:test";\nit.skip("b", () => { expect(3).toBe(3); });\n` },
    ];

    const result = checkTestIntegrity(before, after);
    expect(result.flagged).toBe(true);
    expect(result.findings).toHaveLength(2);
    const byPath = new Map(result.findings.map((f) => [f.path, f.reason]));
    expect(byPath.get("src/a/a.test.ts")).toMatch(/assertion count dropped/);
    expect(byPath.get("src/b/b.test.ts")).toMatch(/skip\/todo/);
  });
});

describe("isTestFilePath", () => {
  it("accepts .test.ts", () => {
    expect(isTestFilePath("src/verify/test_integrity.test.ts")).toBe(true);
  });

  it("accepts .test.tsx", () => {
    expect(isTestFilePath("src/ui/widget.test.tsx")).toBe(true);
  });

  it("rejects a plain .ts source file", () => {
    expect(isTestFilePath("src/verify/test_integrity.ts")).toBe(false);
  });

  it("rejects a file that merely contains 'test' in its name without the convention suffix", () => {
    expect(isTestFilePath("src/verify/testing_utils.ts")).toBe(false);
  });

  it("rejects non-ts extensions even if otherwise matching", () => {
    expect(isTestFilePath("src/verify/test_integrity.test.js")).toBe(false);
  });
});
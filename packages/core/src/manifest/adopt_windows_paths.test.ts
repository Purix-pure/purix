// Windows test D7: an index written on Windows stored backslash paths, and `purix adopt src/totals.ts` said "not in the index".
import { describe, it } from "node:test";
import { expect } from "expect";
import { lookupAdoptable, CODEBASE_INDEX_COMPONENT_ID } from "./adopt";

function manifestWith(files: string[], locations: Array<{ symbol: string; file: string }>) {
  return [{
    component_id: CODEBASE_INDEX_COMPONENT_ID, files,
    components: locations.map((l) => ({ symbol_name: l.symbol, file_location: l.file })),
  }] as any;
}

describe("lookupAdoptable against an index that stored backslashes", () => {
  const m = manifestWith(["src\\totals.ts", "src\\totals.test.ts"], [{ symbol: "sum", file: "src\\totals.ts" }]);
  it("finds a file typed with slashes", () => {
    const r = lookupAdoptable("src/totals.ts", m, process.cwd());
    expect(r.outcome).toBe("adoptable");
  });
  it("finds a symbol and reports its file in the one POSIX form", () => {
    const r: any = lookupAdoptable("sum", m, process.cwd());
    expect(r.outcome).toBe("adoptable");
    expect(r.file).toBe("src/totals.ts");
  });
  it("sees an owner whose stored files use backslashes", () => {
    const owned = [...m, { component_id: "totals", files: ["src\\totals.ts"] }] as any;
    const r: any = lookupAdoptable("src/totals.ts", owned, process.cwd());
    expect(r.outcome).toBe("already_owned");
    expect(r.owner).toBe("totals");
  });
  it("an index written with slashes still works", () => {
    const m2 = manifestWith(["src/totals.ts"], []);
    expect(lookupAdoptable("src/totals.ts", m2, process.cwd()).outcome).toBe("adoptable");
  });
});

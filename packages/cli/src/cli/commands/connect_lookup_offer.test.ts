import { describe, it } from "node:test";
import { expect } from "expect";
import { offerLookup } from "./connect_extras.js";

const mk = (over: Partial<Parameters<typeof offerLookup>[0]> = {}) => {
  const saved: string[] = []; const asked: string[] = [];
  return { saved, asked, deps: { interactive: true, alreadyDecided: false, disclosure: "D", ask: async (q: string) => { asked.push(q); return true; }, save: (s: "on" | "off") => { saved.push(s); }, print: () => {}, ...over } };
};
describe("offerLookup", () => {
  it("asks once and stores yes", async () => { const m = mk(); expect(await offerLookup(m.deps)).toBe("asked-on"); expect(m.saved).toEqual(["on"]); });
  it("stores no too, so it is not asked again", async () => { const m = mk({ ask: async () => false }); expect(await offerLookup(m.deps)).toBe("asked-off"); expect(m.saved).toEqual(["off"]); });
  it("never asks without a terminal or when decided", async () => {
    for (const o of [{ interactive: false }, { alreadyDecided: true }]) { const m = mk(o); expect(await offerLookup(m.deps)).toBe("skipped"); expect(m.asked).toEqual([]); expect(m.saved).toEqual([]); }
  });
});

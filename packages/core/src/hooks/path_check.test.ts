import { describe, it } from "node:test";
import { expect } from "expect";
import { commandResolves, PURIX_NOT_ON_PATH_WARNING } from "./path_check.js";

describe("commandResolves", () => {
  it("is false for a command that does not exist", () => {
    expect(commandResolves("purix-definitely-not-installed-xyz")).toBe(false);
  });
  it("is true for a command that starts and exits 0", () => {
    expect(commandResolves("node")).toBe(true);
  });
  it("goes through the shared spawn rail: a deadline it cannot meet reads as not resolving, not as a hang or a pass", () => {
    // `node --version` cannot finish in 1 ms. Before this change the deadline was a hard-coded 15 s and the argument did not exist.
    expect(commandResolves("node", 1)).toBe(false);
  });
  it("the warning says what is wrong and how to fix it", () => {
    expect(PURIX_NOT_ON_PATH_WARNING).toContain("blocked on every edit");
    expect(PURIX_NOT_ON_PATH_WARNING).toContain("npm link");
  });
});

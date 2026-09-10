// packages/core/src/state/config.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "./config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-config-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createConfigStore", () => {
  test("get on a key that was never set returns undefined", () => {
    const store = createConfigStore(dir);
    expect(store.get("show-savings")).toBeUndefined();
  });

  test("set then get round-trips string, number, and boolean values", () => {
    const store = createConfigStore(dir);
    store.set("show-savings", "off");
    store.set("milestone-threshold", 100);
    store.set("logged-in", false);
    expect(store.get("show-savings")).toBe("off");
    expect(store.get("milestone-threshold")).toBe(100);
    expect(store.get("logged-in")).toBe(false);
  });

  test("persists across separate store instances bound to the same baseDir", () => {
    createConfigStore(dir).set("show-savings", "off");
    const second = createConfigStore(dir);
    expect(second.get("show-savings")).toBe("off");
  });

  test("delete removes a key without disturbing others", () => {
    const store = createConfigStore(dir);
    store.set("a", 1);
    store.set("b", 2);
    store.delete("a");
    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBe(2);
  });

  test("two different baseDirs never see each other's values", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "purix-config-test-"));
    try {
      createConfigStore(dir).set("k", "one");
      createConfigStore(dir2).set("k", "two");
      expect(createConfigStore(dir).get("k")).toBe("one");
      expect(createConfigStore(dir2).get("k")).toBe("two");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("a corrupted config.json degrades to empty rather than throwing", () => {
    mkdirSync(join(dir, ".purix"), { recursive: true });
    writeFileSync(join(dir, ".purix", "config.json"), "{ not valid json");
    const store = createConfigStore(dir);
    expect(store.get("anything")).toBeUndefined();
    expect(store.all()).toEqual({});
  });

  test("writing after a corrupted read overwrites the bad file cleanly", () => {
    mkdirSync(join(dir, ".purix"), { recursive: true });
    writeFileSync(join(dir, ".purix", "config.json"), "{ not valid json");
    const store = createConfigStore(dir);
    store.set("show-savings", "off");
    expect(createConfigStore(dir).get("show-savings")).toBe("off");
  });
});

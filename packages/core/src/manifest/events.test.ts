// src/manifest/events.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { listEvents, recordEvent } from "./events";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

// N-14: this file reaches the project state store, so it runs in a throwaway directory.
isolateCwdForFile();

describe("Manifest Events", () => {
  it("records and lists events", () => {
    recordEvent("request", { component_id: "c1", operation: "test", detail: { msg: "hello" } });
    const events = listEvents({ componentId: "c1" });
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1]?.kind).toBe("request");
  });
});

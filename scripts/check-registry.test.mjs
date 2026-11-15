import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPost, checkPre, expectedTag } from "./check-registry.mjs";

const doc = (versions, tags, attested = true) => ({
  versions: Object.fromEntries(versions.map((v) => [v, { dist: attested ? { attestations: { provenance: {} } } : {} }])),
  "dist-tags": tags,
});
const all = (d) => ["@purix/core", "@purix/mcp-server", "@purix/cli"].map((n) => [n, d]);

test("expectedTag follows the publish.yml rule", () => {
  assert.equal(expectedTag("1.2.3"), "latest");
  assert.equal(expectedTag("0.4.0-beta.2"), "beta");
  assert.equal(expectedTag("0.4.0-rc.1"), "rc");
  assert.equal(expectedTag("0.4.0-1"), "next");
});
test("pre: new version with the right tag passes; unpublished package (null) passes", () => {
  assert.deepEqual(checkPre(all(doc(["0.4.0-beta.1"], {})), "0.4.0-beta.2", "beta"), []);
  assert.deepEqual(checkPre(all(null), "0.4.0-beta.2", "beta"), []);
});
test("pre: existing version and a prerelease on latest both fail", () => {
  assert.equal(checkPre(all(doc(["0.4.0-beta.2"], {})), "0.4.0-beta.2", "beta").length, 3);
  assert.ok(checkPre(all(null), "0.4.0-beta.2", "latest").length >= 1);
});
test("post: passes when version, tag and provenance are there", () => {
  assert.deepEqual(checkPost(all(doc(["0.4.0-beta.2"], { beta: "0.4.0-beta.2" })), "0.4.0-beta.2", "beta"), []);
});
test("post: missing version, wrong tag and missing provenance are each reported", () => {
  assert.equal(checkPost(all(doc([], {})), "0.4.0-beta.2", "beta").length, 3);
  assert.equal(checkPost(all(doc(["0.4.0-beta.2"], { beta: "0.4.0-beta.1" })), "0.4.0-beta.2", "beta").length, 3);
  assert.equal(checkPost(all(doc(["0.4.0-beta.2"], { beta: "0.4.0-beta.2" }, false)), "0.4.0-beta.2", "beta").length, 3);
});

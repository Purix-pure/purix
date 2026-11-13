// Python related-test discovery: name, imports (absolute, relative, transitive), conftest, and the limits.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { discoverRelatedPythonTests, extractPythonImports, isPythonTestPath, isPytestFile, moduleKeys } from "./python_test_discovery.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "purix-pydisc-")); });
afterEach(() => safeRmSync(dir));
const put = (rel: string, body = "") => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), body); };

describe("what is a test file", () => {
  it("follows pytest's patterns, conftest.py and tests/ folders", () => {
    for (const p of ["test_a.py", "a_test.py", "tests/a.py", "pkg/test/helpers.py", "conftest.py", "src/tests/conftest.py"]) expect(isPythonTestPath(p)).toBe(true);
    for (const p of ["a.py", "latest_report.py", "src/contest.py", "notes.txt"]) expect(isPythonTestPath(p)).toBe(false);
  });
  it("only test_*.py and *_test.py can be handed to pytest", () => {
    expect(isPytestFile("tests/test_a.py")).toBe(true);
    expect(isPytestFile("a_test.py")).toBe(true);
    expect(isPytestFile("tests/helpers.py")).toBe(false);
    expect(isPytestFile("conftest.py")).toBe(false);
  });
});

describe("moduleKeys", () => {
  it("lists every dotted suffix and treats __init__ as the package", () => {
    expect(moduleKeys("src/pkg/mod.py")).toEqual(["mod", "pkg.mod", "src.pkg.mod"]);
    expect(moduleKeys("pkg/__init__.py")).toEqual(["pkg"]);
  });
});

describe("extractPythonImports", () => {
  it("reads import, from-import, aliases, relative dots and parenthesised multi-line lists", () => {
    const refs = extractPythonImports([
      "import os, pkg.mod as m",
      "from pkg import a, b as bb",
      "from .sibling import (",
      "    x,  # comment",
      "    y,",
      ")",
      "from .. import up",
    ].join("\n"));
    expect(refs).toContainEqual({ level: 0, module: "pkg", names: ["a", "b"] });
    expect(refs).toContainEqual({ level: 1, module: "sibling", names: ["x", "y"] });
    expect(refs).toContainEqual({ level: 2, module: "", names: ["up"] });
    expect(refs).toContainEqual({ level: 0, module: "pkg.mod", names: [] });
    expect(refs).toContainEqual({ level: 0, module: "os", names: [] });
  });
});

describe("discoverRelatedPythonTests", () => {
  it("selects a test by name (test_x.py and x_test.py) and by folder", () => {
    put("src/cart.py", "def total(): return 1\n");
    put("tests/test_cart.py", "def test_x(): pass\n");
    put("src/other_test.py", "def test_y(): pass\n");
    put("src/other.py", "x = 1\n");
    const r = discoverRelatedPythonTests(["src/cart.py", "src/other.py"], dir);
    expect(r.tests).toEqual(["src/other_test.py", "tests/test_cart.py"]);
    expect(r.uncovered).toEqual([]);
    expect(r.reasons["tests/test_cart.py"]).toEqual(["name matches src/cart.py"]);
  });

  it("selects a test that imports the changed module, absolute and from-import", () => {
    put("pkg/__init__.py");
    put("pkg/pricing.py", "RATE = 1\n");
    put("tests/test_checkout.py", "from pkg import pricing\n\ndef test_c(): pass\n");
    put("tests/test_rate.py", "from pkg.pricing import RATE\n\ndef test_r(): pass\n");
    const r = discoverRelatedPythonTests(["pkg/pricing.py"], dir);
    expect(r.tests).toEqual(["tests/test_checkout.py", "tests/test_rate.py"]);
  });

  it("follows relative imports", () => {
    put("app/__init__.py");
    put("app/util.py", "x = 1\n");
    put("app/service.py", "from .util import x\n");
    put("app/test_service.py", "from . import service\n\ndef test_s(): pass\n");
    const r = discoverRelatedPythonTests(["app/util.py"], dir);
    expect(r.tests).toEqual(["app/test_service.py"]);
    expect(r.reasons["app/test_service.py"]![0]).toMatch(/imports app\/service\.py, which depends on app\/util\.py/);
  });

  it("goes through a chain of project files and survives an import cycle", () => {
    put("a.py", "import b\n");
    put("b.py", "import c\nimport a\n");
    put("c.py", "x = 1\n");
    put("tests/test_a.py", "import a\n");
    const r = discoverRelatedPythonTests(["c.py"], dir);
    expect(r.tests).toEqual(["tests/test_a.py"]);
  });

  it("a changed test file selects itself, and a helper in tests/ is treated as source", () => {
    put("tests/test_a.py", "def test_a(): pass\n");
    put("tests/helpers.py", "x = 1\n");
    put("tests/test_b.py", "from tests import helpers\n\ndef test_b(): pass\n");
    expect(discoverRelatedPythonTests(["tests/test_a.py"], dir).tests).toEqual(["tests/test_a.py"]);
    const r = discoverRelatedPythonTests(["tests/helpers.py"], dir);
    expect(r.tests).toEqual(["tests/test_b.py"]);
  });

  it("a changed conftest.py selects the tests below it", () => {
    put("tests/conftest.py", "import pytest\n");
    put("tests/test_a.py", "def test_a(): pass\n");
    put("other/test_z.py", "def test_z(): pass\n");
    const r = discoverRelatedPythonTests(["tests/conftest.py"], dir);
    expect(r.tests).toEqual(["tests/test_a.py"]);
  });

  it("reports a file nothing relates to as uncovered, even when other tests exist", () => {
    put("a.py", "x = 1\n");
    put("b.py", "y = 1\n");
    put("test_a.py", "import a\n");
    const r = discoverRelatedPythonTests(["b.py"], dir);
    expect(r.tests).toEqual([]);
    expect(r.uncovered).toEqual(["b.py"]);
  });

  it("ignores non-Python files and skips virtualenv and cache folders", () => {
    put(".venv/lib/test_vendor.py", "import a\n");
    put("a.py", "x = 1\n");
    const r = discoverRelatedPythonTests(["a.py", "README.md"], dir);
    expect(r.tests).toEqual([]);
    expect(r.uncovered).toEqual(["a.py"]);
  });
});

/**
 * tests/fuzzy-edit.test.ts
 *
 * The fuzzy whitespace-tolerant matcher used by `edit_file`. Pins:
 *
 *   1. Exact match: always preferred, no whitespace normalisation runs
 *   2. Tab/space bridging at multiple widths — the original bug was
 *      that `tab = 2 spaces` was hardcoded, so a file using TAB
 *      indentation (effective width 4, very common in Go / TS / Make)
 *      couldn't be edited when the LLM emitted 4-space indent
 *   3. Replacement re-emits in the FILE'S indent style — a tabs file
 *      stays a tabs file even when the LLM sent spaces in `replace`
 *   4. Existing exact-match behavior is unchanged
 *
 * The fix tries `[4, 2, 8]` tab widths in priority order (4 first
 * because it covers the modal LLM output for TS / Python / Go).
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { fuzzyEdit, fuzzyFind } from "../src/task/tools/_fuzzy-edit.js";

// ─── Tab ↔ space bridging ────────────────────────────────────────────────────

describe("fuzzyEdit — tab/space bridging (the original bug)", () => {
  it("file uses TABS (tab=4), find uses 4 spaces → matches via fuzzy", () => {
    const file = "function foo() {\n\treturn 42;\n}\n";
    const find = "function foo() {\n    return 42;\n}";
    const replace = "function foo() {\n    return 100;\n}";
    const result = fuzzyEdit(file, find, replace);
    assert.ok(result, "should match (would have failed before the fix)");
    assert.equal(result.matchType, "fuzzy");
    // Replacement re-emitted with tabs to match the file's style.
    assert.equal(result.content, "function foo() {\n\treturn 100;\n}\n");
  });

  it("file uses 4-space, find uses TABS → matches via fuzzy", () => {
    const file = "function foo() {\n    return 42;\n}\n";
    const find = "function foo() {\n\treturn 42;\n}";
    const replace = "function foo() {\n\treturn 100;\n}";
    const result = fuzzyEdit(file, find, replace);
    assert.ok(result);
    assert.equal(result.matchType, "fuzzy");
    // Replacement re-emitted with spaces to match the file's style.
    assert.equal(result.content, "function foo() {\n    return 100;\n}\n");
  });

  it("file uses TABS (tab=2 effectively), find uses 2 spaces → still matches", () => {
    // Regression: pre-fix code only worked at tab=2, so this case
    // continues to pass.
    const file = "if (x) {\n\treturn 1;\n}\n";
    const find = "if (x) {\n  return 1;\n}";
    const replace = "if (x) {\n  return 2;\n}";
    const result = fuzzyEdit(file, find, replace);
    assert.ok(result);
    assert.equal(result.matchType, "fuzzy");
    assert.equal(result.content, "if (x) {\n\treturn 2;\n}\n");
  });

  it("preserves tab indent depth across nested blocks", () => {
    const file = "class A {\n\tfoo() {\n\t\treturn 1;\n\t}\n}\n";
    // Inner method, find written with deeper indent (4 + 8 spaces) —
    // tab=4 matches `\t` and `\t\t` in the file.
    const find = "    foo() {\n        return 1;\n    }";
    const replace = "    foo() {\n        return 99;\n    }";
    const result = fuzzyEdit(file, find, replace);
    assert.ok(result);
    assert.equal(result.matchType, "fuzzy");
    assert.equal(result.content, "class A {\n\tfoo() {\n\t\treturn 99;\n\t}\n}\n");
  });
});

// ─── Tab width is reported back ──────────────────────────────────────────────

describe("fuzzyFind — reports the tab width that won", () => {
  it("sets tabWidth=4 when 4-space find matches a tab file", () => {
    const file = "{\n\treturn 1;\n}";
    const find = "{\n    return 1;\n}";
    const r = fuzzyFind(file, find);
    assert.equal(r.matchType, "fuzzy");
    assert.equal(r.tabWidth, 4);
  });

  it("sets tabWidth=2 when 2-space find matches a tab file (and tab=4 doesn't fit)", () => {
    const file = "{\n\treturn 1;\n}";
    const find = "{\n  return 1;\n}";
    const r = fuzzyFind(file, find);
    assert.equal(r.matchType, "fuzzy");
    assert.equal(r.tabWidth, 2);
  });

  it("does NOT set tabWidth for exact matches", () => {
    const file = "exact match here";
    const r = fuzzyFind(file, "match");
    assert.equal(r.matchType, "exact");
    assert.equal(r.tabWidth, undefined);
  });
});

// ─── Happy path unchanged ────────────────────────────────────────────────────

describe("fuzzyEdit — no regression on happy paths", () => {
  it("exact match short-circuits before any normalisation", () => {
    const file = "alpha beta gamma";
    const result = fuzzyEdit(file, "beta", "BETA");
    assert.ok(result);
    assert.equal(result.matchType, "exact");
    assert.equal(result.content, "alpha BETA gamma");
  });

  it("returns null when neither exact nor any fuzzy width matches", () => {
    const file = "if (x) {\n    return 1;\n}\n";
    const find = "if (y) {\n    return 2;\n}"; // genuinely different content
    const result = fuzzyEdit(file, find, "X");
    assert.equal(result, null);
  });

  it("4-space file, 4-space find = exact match (no fuzzy needed)", () => {
    const file = "if (x) {\n    return 1;\n}\n";
    const find = "if (x) {\n    return 1;\n}";
    const replace = "if (x) {\n    return 2;\n}";
    const result = fuzzyEdit(file, find, replace);
    assert.ok(result);
    assert.equal(result.matchType, "exact");
    assert.equal(result.content, "if (x) {\n    return 2;\n}\n");
  });

  it("tabs-everywhere = exact match", () => {
    const file = "if (x) {\n\treturn 1;\n}\n";
    const find = "if (x) {\n\treturn 1;\n}";
    const replace = "if (x) {\n\treturn 2;\n}";
    const result = fuzzyEdit(file, find, replace);
    assert.ok(result);
    assert.equal(result.matchType, "exact");
    assert.equal(result.content, "if (x) {\n\treturn 2;\n}\n");
  });
});

// ─── Trailing-whitespace tolerance kept ─────────────────────────────────────

describe("fuzzyEdit — orthogonal whitespace tolerance still works", () => {
  it("matches despite trailing-space differences", () => {
    const file = "foo  \nbar\n";
    const find = "foo\nbar";
    const replace = "X\nY";
    const result = fuzzyEdit(file, find, replace);
    assert.ok(result);
    assert.equal(result.matchType, "fuzzy");
  });
});

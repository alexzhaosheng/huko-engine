/**
 * tests/best-practices-built-in.test.ts
 *
 * Covers the engine-bundled best-practices convenience:
 *   - section extraction (`extractBestPracticesSection`)
 *   - body processing pipeline (`resolveBestPracticeBody`)
 *   - capability lookup against the built-in map
 *     (`resolveBuiltInBestPractice`)
 *   - final injection compose (`formatBestPracticesInjection`)
 *   - the four bundled markdown blobs are well-formed
 *   - `defaultBestPracticesProvider` end-to-end behaviour
 *
 * cli's filesystem-override wrapper has its own narrower tests
 * (`packages/huko-cli/tests/best-practices.test.ts`); this file pins
 * the engine surface those build on.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  BUILT_IN_BEST_PRACTICES,
  defaultBestPracticesProvider,
  extractBestPracticesSection,
  formatBestPracticesInjection,
  resolveBestPracticeBody,
  resolveBuiltInBestPractice,
} from "../src/index.js";

// ─── extractBestPracticesSection ────────────────────────────────────────────

describe("extractBestPracticesSection", () => {
  it("returns null when no section is present", () => {
    const body = "# Identity\n\nYou are an agent.\n\n# Tool usage\n\nRead first.";
    assert.equal(extractBestPracticesSection(body), null);
  });

  it("extracts a `## Best Practices` block (case-insensitive)", () => {
    const body = [
      "You are an agent.",
      "",
      "## Best practices",
      "- MUST do this",
      "- MUST NOT do that",
    ].join("\n");
    const got = extractBestPracticesSection(body);
    assert.ok(got);
    assert.match(got!, /MUST do this/);
    assert.match(got!, /MUST NOT do that/);
  });

  it("stops at the next `##` heading", () => {
    const body = [
      "## Best Practices",
      "- bullet one",
      "- bullet two",
      "",
      "## Notes",
      "- this should NOT be included",
    ].join("\n");
    const got = extractBestPracticesSection(body);
    assert.ok(got);
    assert.match(got!, /bullet one/);
    assert.match(got!, /bullet two/);
    assert.doesNotMatch(got!, /should NOT be included/);
  });

  it("handles end-of-body cleanly", () => {
    const body = "## Best Practices\n- only bullet";
    const got = extractBestPracticesSection(body);
    assert.equal(got, "## Best Practices\n- only bullet");
  });
});

// ─── resolveBestPracticeBody ────────────────────────────────────────────────

describe("resolveBestPracticeBody", () => {
  it("strips a YAML frontmatter fence before processing", () => {
    const raw = [
      "---",
      "description: foo",
      "---",
      "",
      "## Best Practices",
      "- only rule",
    ].join("\n");
    const out = resolveBestPracticeBody(raw);
    assert.ok(out);
    assert.match(out!, /## Best Practices/);
    assert.match(out!, /only rule/);
    assert.doesNotMatch(out!, /description:/);
  });

  it("falls back to whole body when no section heading is present", () => {
    const raw = "Body without any heading.\nSecond line.";
    const out = resolveBestPracticeBody(raw);
    assert.equal(out, "Body without any heading.\nSecond line.");
  });

  it("returns null when the processed body is empty", () => {
    assert.equal(resolveBestPracticeBody("   \n\n  "), null);
    assert.equal(resolveBestPracticeBody(""), null);
  });

  it("caps the body and appends a truncation marker", () => {
    const long = "x".repeat(2000);
    const out = resolveBestPracticeBody(long, 100);
    assert.ok(out);
    assert.ok(out!.startsWith("x".repeat(100)));
    assert.match(out!, /…\(truncated\)/);
  });
});

// ─── resolveBuiltInBestPractice ─────────────────────────────────────────────

describe("resolveBuiltInBestPractice", () => {
  it("returns null for unknown capabilities", () => {
    assert.equal(resolveBuiltInBestPractice("definitely_not_a_capability"), null);
  });

  for (const name of ["coding", "writing", "research", "analysis"]) {
    it(`returns the ${name} checklist`, () => {
      const out = resolveBuiltInBestPractice(name);
      assert.ok(out, `${name} should resolve`);
      assert.match(out!, /## Best Practices/i);
      assert.ok(out!.length > 100, `${name} body suspiciously short`);
    });
  }

  it("respects the maxBodyChars cap", () => {
    const out = resolveBuiltInBestPractice("coding", 80);
    assert.ok(out);
    assert.match(out!, /…\(truncated\)/);
  });
});

// ─── BUILT_IN_BEST_PRACTICES map ────────────────────────────────────────────

describe("BUILT_IN_BEST_PRACTICES", () => {
  it("ships exactly the four foundational capabilities", () => {
    const names = Object.keys(BUILT_IN_BEST_PRACTICES).sort();
    assert.deepEqual(names, ["analysis", "coding", "research", "writing"]);
  });

  for (const [name, body] of Object.entries(BUILT_IN_BEST_PRACTICES)) {
    it(`${name} blob has a frontmatter fence + a Best Practices section`, () => {
      assert.match(body, /^---\n/, `${name} should start with a YAML fence`);
      assert.match(body, /## Best Practices/i);
    });
  }
});

// ─── formatBestPracticesInjection ───────────────────────────────────────────

describe("formatBestPracticesInjection", () => {
  it("returns null when entries is empty", () => {
    assert.equal(formatBestPracticesInjection(1, "x", []), null);
  });

  it("renders the canonical header + per-capability blocks", () => {
    const out = formatBestPracticesInjection(3, "Investigate", [
      { name: "research", body: "- cite sources" },
      { name: "writing", body: "- use markdown" },
    ]);
    assert.ok(out);
    assert.match(out!, /\[Phase 3: Investigate — Expert Checklist\]/);
    assert.match(out!, /following best practices apply to this phase/i);
    assert.match(out!, /\[Role: research\]\n- cite sources/);
    assert.match(out!, /\[Role: writing\]\n- use markdown/);
    const idxR = out!.indexOf("[Role: research]");
    const idxW = out!.indexOf("[Role: writing]");
    assert.ok(idxR < idxW, "preserves caller-supplied order");
  });
});

// ─── defaultBestPracticesProvider ───────────────────────────────────────────

describe("defaultBestPracticesProvider", () => {
  it("returns null when capabilities is empty / undefined", async () => {
    assert.equal(await defaultBestPracticesProvider(1, "X", undefined), null);
    assert.equal(await defaultBestPracticesProvider(1, "X", []), null);
  });

  it("returns null when no capability resolves to a built-in", async () => {
    const r = await defaultBestPracticesProvider(1, "X", [
      "no_such_capability_in_built_in_map",
    ]);
    assert.equal(r, null);
  });

  it("resolves the writing built-in end-to-end", async () => {
    const r = await defaultBestPracticesProvider(2, "Draft prose", ["writing"]);
    assert.ok(r);
    assert.match(r!, /Phase 2: Draft prose/);
    assert.match(r!, /\[Role: writing\]/);
    assert.match(r!, /MUST.*write_file/);
  });

  it("composes multiple built-ins in caller order", async () => {
    const r = await defaultBestPracticesProvider(
      3,
      "Synthesise + write",
      ["research", "writing"],
    );
    assert.ok(r);
    const idxR = r!.indexOf("[Role: research]");
    const idxW = r!.indexOf("[Role: writing]");
    assert.ok(idxR > 0 && idxW > idxR);
  });

  it("silently skips unknown capabilities mixed with known ones", async () => {
    const r = await defaultBestPracticesProvider(
      1,
      "Mixed",
      ["definitely_not_a_role_xyz123", "writing"],
    );
    assert.ok(r);
    assert.match(r!, /\[Role: writing\]/);
    assert.doesNotMatch(r!, /\[Role: definitely_not_a_role/);
  });
});

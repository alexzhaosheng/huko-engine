/**
 * tests/prompt-overlay.test.ts
 *
 * Regression cover for the prompt-overlay refactor. The new structured
 * `overlays: PromptOverlay[]` field must produce byte-identical output
 * to the legacy `extraOverlays: string[]` field when the same content
 * lands at the same position.
 *
 * If this test ever needs to be "fixed" by changing whitespace
 * handling, separator joining, or the canonical block order — STOP.
 * That would change the rendered system prompt for live agents and
 * invalidate Anthropic's prompt cache. The test is the contract.
 *
 * What this pins:
 *
 *   1. A tail-positioned PromptOverlay matches the legacy
 *      `extraOverlays` for the same content (the current cli setup-
 *      assistant case).
 *   2. Mixing `extraOverlays` and `overlays` with the same content
 *      produces ONE block per pass through (no dedup; the engine
 *      trusts the host). Today nobody mixes them; this asserts the
 *      composition rule is deterministic.
 *   3. The three position slots ("after-skills",
 *      "after-project-context", "tail") render in the canonical
 *      order regardless of input array order.
 *   4. Empty overlay content is filtered.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Tests sit in the same workspace as the engine source; reach the
// internal assembler via a relative path. The published package's
// exports map omits `internal/*` (npm consumers can't import it),
// so the package-name form `@alexzhaosheng/huko-engine/internal/...`
// is intentionally rejected at the export boundary.
import {
  assembleSystemPrompt,
  type AssembleSystemPromptInput,
} from "../src/internal/prompt/assemble.js";

const SETUP_ASSISTANT_BLOCK = `<setup_assistant>
- Only configure huko via \`huko ...\` bash commands.
- Surface destructive ops via message(info) before running them.
- Treat the current-config snapshot as authoritative.
</setup_assistant>`;

const FIXED_DATE = new Date("2026-05-26T00:00:00Z");

const BASE_INPUT: AssembleSystemPromptInput = {
  workingDirectory: "/tmp/project",
  platform: "linux",
  workingLanguage: null,
  currentDate: FIXED_DATE,
  toolHints: [],
  skills: [],
  projectContext: null,
};

describe("prompt overlays — back-compat with extraOverlays", () => {
  it("a tail-position PromptOverlay renders identically to the same string in extraOverlays", () => {
    const legacy = assembleSystemPrompt({
      ...BASE_INPUT,
      extraOverlays: [SETUP_ASSISTANT_BLOCK],
    });

    const structured = assembleSystemPrompt({
      ...BASE_INPUT,
      overlays: [
        { name: "setup-assistant", content: SETUP_ASSISTANT_BLOCK, position: "tail" },
      ],
    });

    assert.equal(structured, legacy, "structured overlay should match legacy extraOverlays byte-for-byte");
  });

  it("default position (no `position` field) is tail", () => {
    const explicit = assembleSystemPrompt({
      ...BASE_INPUT,
      overlays: [
        { name: "x", content: "<x>example</x>", position: "tail" },
      ],
    });

    const defaulted = assembleSystemPrompt({
      ...BASE_INPUT,
      overlays: [{ name: "x", content: "<x>example</x>" }],
    });

    assert.equal(defaulted, explicit, "no position field should default to tail");
  });

  it("legacy extraOverlays + structured tail overlays both render, legacy first", () => {
    const out = assembleSystemPrompt({
      ...BASE_INPUT,
      extraOverlays: ["<legacy>L</legacy>"],
      overlays: [{ name: "new", content: "<new>N</new>", position: "tail" }],
    });

    const legacyIdx = out.indexOf("<legacy>L</legacy>");
    const newIdx = out.indexOf("<new>N</new>");
    assert.ok(legacyIdx > 0, "legacy block should be present");
    assert.ok(newIdx > 0, "structured block should be present");
    assert.ok(legacyIdx < newIdx, "legacy renders before structured tail overlays");
  });
});

describe("prompt overlays — position slotting", () => {
  it("after-skills sits before project context", () => {
    const out = assembleSystemPrompt({
      ...BASE_INPUT,
      skills: [
        {
          name: "test-skill",
          frontmatter: { name: "test-skill" },
          body: "skill body here",
          source: "global",
        },
      ],
      projectContext: "PROJECT_CTX_MARKER",
      overlays: [
        { name: "after-skills-tag", content: "<after-skills>AS</after-skills>", position: "after-skills" },
      ],
    });

    const skillsIdx = out.indexOf("<skills>");
    const overlayIdx = out.indexOf("<after-skills>AS</after-skills>");
    const projectIdx = out.indexOf("PROJECT_CTX_MARKER");

    assert.ok(skillsIdx >= 0, "skills block should render");
    assert.ok(overlayIdx > skillsIdx, "after-skills overlay should come AFTER skills");
    assert.ok(projectIdx > overlayIdx, "after-skills overlay should come BEFORE project context");
  });

  it("after-project-context sits between project context and tail", () => {
    const out = assembleSystemPrompt({
      ...BASE_INPUT,
      projectContext: "PROJECT_CTX_MARKER",
      overlays: [
        { name: "tail-tag", content: "<tail>T</tail>", position: "tail" },
        { name: "apc-tag", content: "<apc>APC</apc>", position: "after-project-context" },
      ],
    });

    const projectIdx = out.indexOf("PROJECT_CTX_MARKER");
    const apcIdx = out.indexOf("<apc>APC</apc>");
    const tailIdx = out.indexOf("<tail>T</tail>");

    assert.ok(projectIdx > 0);
    assert.ok(apcIdx > projectIdx, "after-project-context overlay sits after project context");
    assert.ok(tailIdx > apcIdx, "tail overlay sits after after-project-context overlay");
  });

  it("same-position overlays render in input order", () => {
    const out = assembleSystemPrompt({
      ...BASE_INPUT,
      overlays: [
        { name: "a", content: "<a>A</a>", position: "tail" },
        { name: "b", content: "<b>B</b>", position: "tail" },
      ],
    });

    const aIdx = out.indexOf("<a>A</a>");
    const bIdx = out.indexOf("<b>B</b>");
    assert.ok(aIdx > 0 && bIdx > aIdx, "input order is preserved within a position");
  });

  it("empty / whitespace-only overlays are dropped", () => {
    const baseline = assembleSystemPrompt({ ...BASE_INPUT });
    const withEmpty = assembleSystemPrompt({
      ...BASE_INPUT,
      overlays: [
        { name: "blank", content: "   \n   \n  ", position: "tail" },
        { name: "empty", content: "", position: "after-project-context" },
      ],
    });
    assert.equal(withEmpty, baseline, "all-empty overlays should not add anything");
  });
});

describe("prompt overlays — volatile position (post-cache-boundary)", () => {
  // The cache-boundary sentinel sits in `current-date` line; everything
  // strictly before it is the prefix that providers' prompt caches try
  // to hit byte-for-byte. The whole point of the volatile slot is to
  // let hosts attach per-turn changing content WITHOUT shifting that
  // prefix. The pin: changing volatile content must not change ANY
  // byte at or before the boundary.

  const CACHE_BOUNDARY_MARKER = "The current date is";

  it("volatile overlay renders AFTER the cache boundary + current-date line", () => {
    const out = assembleSystemPrompt({
      ...BASE_INPUT,
      overlays: [
        { name: "tail-x", content: "<tail>T</tail>", position: "tail" },
        { name: "vol-x", content: "<volatile>V</volatile>", position: "volatile" },
      ],
    });

    const tailIdx = out.indexOf("<tail>T</tail>");
    const dateIdx = out.indexOf(CACHE_BOUNDARY_MARKER);
    const volIdx = out.indexOf("<volatile>V</volatile>");

    assert.ok(tailIdx > 0, "tail overlay should render");
    assert.ok(dateIdx > tailIdx, "current-date boundary follows tail overlays");
    assert.ok(volIdx > dateIdx, "volatile overlay follows the cache boundary");
  });

  it("changing volatile content leaves the cache prefix byte-identical", () => {
    const promptA = assembleSystemPrompt({
      ...BASE_INPUT,
      overlays: [
        { name: "tail-stable", content: "<tail>STABLE</tail>", position: "tail" },
        { name: "live", content: "snapshot A — selectedId=record-1", position: "volatile" },
      ],
    });
    const promptB = assembleSystemPrompt({
      ...BASE_INPUT,
      overlays: [
        { name: "tail-stable", content: "<tail>STABLE</tail>", position: "tail" },
        { name: "live", content: "snapshot B — selectedId=record-42 (much longer text here)", position: "volatile" },
      ],
    });

    // The prefix runs from the start through (and including) the
    // current-date line. Everything after must be allowed to differ;
    // everything up to and including it must NOT.
    const cutA = promptA.indexOf(CACHE_BOUNDARY_MARKER);
    const cutB = promptB.indexOf(CACHE_BOUNDARY_MARKER);
    assert.ok(cutA > 0 && cutB > 0, "boundary marker present in both renders");

    // Find the end of the current-date line in each.
    const endA = promptA.indexOf("\n", cutA);
    const endB = promptB.indexOf("\n", cutB);
    const prefixA = endA > 0 ? promptA.slice(0, endA) : promptA.slice(0, cutA + CACHE_BOUNDARY_MARKER.length);
    const prefixB = endB > 0 ? promptB.slice(0, endB) : promptB.slice(0, cutB + CACHE_BOUNDARY_MARKER.length);

    assert.equal(
      prefixA,
      prefixB,
      "the cache-stable prefix MUST be byte-identical regardless of volatile content",
    );
    assert.notEqual(promptA, promptB, "tails do still differ");
  });

  it("multiple volatile overlays render in input order, all after the boundary", () => {
    const out = assembleSystemPrompt({
      ...BASE_INPUT,
      overlays: [
        { name: "v1", content: "<v1>first</v1>", position: "volatile" },
        { name: "v2", content: "<v2>second</v2>", position: "volatile" },
      ],
    });

    const dateIdx = out.indexOf(CACHE_BOUNDARY_MARKER);
    const v1Idx = out.indexOf("<v1>first</v1>");
    const v2Idx = out.indexOf("<v2>second</v2>");

    assert.ok(dateIdx > 0);
    assert.ok(v1Idx > dateIdx, "first volatile is after the boundary");
    assert.ok(v2Idx > v1Idx, "second volatile follows the first in input order");
  });

  it("volatile overlays don't appear at all when none are provided (no extra trailing blocks)", () => {
    const baseline = assembleSystemPrompt({ ...BASE_INPUT });
    const expectedTail = baseline.trimEnd();
    // The base prompt should end with the current-date line — adding
    // the volatile slot must not introduce a trailing separator when
    // the bucket is empty.
    assert.match(
      expectedTail,
      /The current date is .+\.$/,
      "with no volatile overlays, the prompt ends right after the current-date line",
    );
  });
});

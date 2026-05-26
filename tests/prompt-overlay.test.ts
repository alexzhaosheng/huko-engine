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

import {
  assembleSystemPrompt,
  type AssembleSystemPromptInput,
} from "@alexzhaosheng/huko-engine/internal/prompt/assemble.js";

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

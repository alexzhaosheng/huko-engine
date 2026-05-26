/**
 * tests/prompt-hints.test.ts
 *
 * Coverage for the tool-registry's prompt-hint surface:
 *   - getToolPromptHints returns hints from registered tools
 *   - filter respects allowedTools / deniedTools
 *   - hints empty for tools without promptHint
 *
 * Foundational engine tools (message, plan, web_fetch, web_search,
 * delete_file, etc.) carry promptHint strings the system-prompt
 * assembler splices into <tool_use>. This file pins which built-ins
 * contribute hints + how the filter interacts.
 *
 * The system-prompt splicing itself is covered by
 * `prompt-assemble.test.ts` (toolHints integration).
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Side-effect: register foundational tools into the global registry.
import "../src/task/tools/index.js";
import { getToolPromptHints } from "../src/task/tools/registry.js";

describe("getToolPromptHints", () => {
  it("returns hints from all registered tools by default", () => {
    const hints = getToolPromptHints();
    assert.ok(hints.length >= 4, `expected >= 4 hints, got ${hints.length}`);
    const blob = hints.join("\n\n");
    assert.match(blob, /Talking to the user/);
    assert.match(blob, /Planning \(`plan`/);
    assert.match(blob, /Web research/);
    assert.match(blob, /File deletion/);
  });

  it("respects allowedTools filter", () => {
    const hints = getToolPromptHints({ allowedTools: ["message"] });
    assert.equal(hints.length, 1);
    assert.match(hints[0]!, /Talking to the user/);
  });

  it("respects deniedTools filter", () => {
    const hints = getToolPromptHints({
      deniedTools: ["plan", "delete_file", "web_search"],
    });
    const blob = hints.join("\n\n");
    assert.match(blob, /Talking to the user/);
    assert.doesNotMatch(blob, /Planning \(`plan`/);
    assert.doesNotMatch(blob, /Web research/);
    assert.doesNotMatch(blob, /File deletion/);
  });

  it("returns empty when allowedTools is empty (no tools visible)", () => {
    const hints = getToolPromptHints({ allowedTools: [] });
    assert.deepEqual(hints, []);
  });

  it("preserves registration order", () => {
    const hints = getToolPromptHints();
    const idxMessage = hints.findIndex((h) => h.includes("Talking to the user"));
    const idxPlan = hints.findIndex((h) => h.includes("Planning (`plan`"));
    const idxSearch = hints.findIndex((h) => h.includes("Web research"));
    const idxDelete = hints.findIndex((h) => h.includes("File deletion"));
    // src/task/tools/index.ts imports message → plan → web-fetch →
    // web-search → ... → write-file → edit-file → delete-file → ...
    assert.ok(idxMessage >= 0 && idxPlan >= 0 && idxSearch >= 0 && idxDelete >= 0);
    assert.ok(idxMessage < idxPlan, "message should precede plan");
    assert.ok(idxPlan < idxSearch, "plan should precede web_search");
    assert.ok(idxSearch < idxDelete, "web_search should precede delete_file");
  });
});

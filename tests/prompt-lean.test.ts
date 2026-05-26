/**
 * tests/prompt-lean.test.ts
 *
 * Verifies that `assembleLeanSystemPrompt` is structurally isolated
 * from `assembleSystemPrompt` — it must NOT contain any of the default
 * composer's content blocks (agent_loop, tool_use rules,
 * project_context, role, etc.). Adding content to either composer
 * must not leak into the other.
 *
 * Lean profile target: ~300-500 tokens, shell-only tool surface,
 * "give me just bash" prompt. The composer is its own file
 * (src/prompt/lean.ts) for exactly this isolation guarantee.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { assembleLeanSystemPrompt } from "../src/internal/prompt/lean.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../src/llm/cache-boundary.js";

describe("assembleLeanSystemPrompt", () => {
  it("produces a compact prompt (target ~300-500 tokens, <1500 chars)", () => {
    const out = assembleLeanSystemPrompt({ workingLanguage: "English" });
    assert.ok(out.length < 1500, `lean prompt should be small, got ${out.length} chars`);
    assert.ok(out.length > 100, "lean prompt should not be empty");
  });

  it("mentions bash as the one available tool", () => {
    const out = assembleLeanSystemPrompt({});
    assert.match(out, /\bbash\b/);
  });

  it("does NOT include default-composer content blocks", () => {
    const out = assembleLeanSystemPrompt({});
    assert.doesNotMatch(out, /<agent_loop>/);
    assert.doesNotMatch(out, /<tool_use>/);
    assert.doesNotMatch(out, /<error_handling>/);
    assert.doesNotMatch(out, /<local>/);
    assert.doesNotMatch(out, /<safety>/);
    assert.doesNotMatch(out, /<disclosure_prohibition>/);
    assert.doesNotMatch(out, /<role/);
    assert.doesNotMatch(out, /<project_context>/);
    assert.doesNotMatch(out, /<format>/);
  });

  it("retains the cache boundary sentinel and date line at the tail", () => {
    const out = assembleLeanSystemPrompt({});
    assert.ok(out.includes(SYSTEM_PROMPT_CACHE_BOUNDARY), "must keep cache boundary");
    assert.match(out, /The current date is /);
    const boundaryIdx = out.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const dateIdx = out.indexOf("The current date is ");
    assert.ok(dateIdx > boundaryIdx, "date must appear after boundary");
  });

  it("includes the working-language block with the supplied language", () => {
    const out = assembleLeanSystemPrompt({ workingLanguage: "中文" });
    assert.match(out, /<language>/);
    assert.match(out, /\*\*中文\*\*/);
  });

  it("falls back to first-message-language directive when language is null", () => {
    const out = assembleLeanSystemPrompt({});
    assert.match(out, /first message/);
  });

  it("identity line marks the mode explicitly", () => {
    const out = assembleLeanSystemPrompt({});
    assert.match(out, /lean mode/);
  });
});

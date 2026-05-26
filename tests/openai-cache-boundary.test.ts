/**
 * tests/openai-cache-boundary.test.ts
 *
 * The system prompt embeds the `SYSTEM_PROMPT_CACHE_BOUNDARY` sentinel
 * as a placement marker. It is a contract between the assembler and
 * the openai adapter:
 *
 *   - assembler  : places the marker BEFORE the volatile current-date
 *                  line so the cacheable prefix is stable across calls
 *   - openai adapter : strips the marker out of `messages[].content`
 *                  before sending the payload upstream
 *
 * This test pins the strip step. If it ever needs to be "fixed" by
 * keeping the marker in the wire payload — STOP. The Anthropic prompt
 * cache fingerprints message content; an opaque sentinel in there
 * would defeat caching.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { openaiAdapter } from "../src/llm/adapters/openai.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../src/llm/cache-boundary.js";
import type { LLMCallOptions, LLMMessage } from "../src/llm/types.js";

describe("openai adapter — cache-boundary marker", () => {
  it("strips the marker from system messages before send", async () => {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: `BEFORE${SYSTEM_PROMPT_CACHE_BOUNDARY}AFTER`,
      },
      { role: "user", content: "hi" },
    ];

    let captured: { messages: Array<{ role: string; content: unknown }> } | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init: { body?: string } = {}) => {
      captured = JSON.parse(init.body ?? "{}");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok", tool_calls: [] } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const opts: LLMCallOptions = {
        protocol: "openai",
        baseUrl: "https://example.invalid",
        apiKey: "k",
        model: "gpt-test",
        messages,
        tools: [],
        toolCallMode: "native",
        thinkLevel: "off",
      };
      await openaiAdapter.call(opts);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(captured, "fetch was not invoked");
    const sysMsg = captured!.messages.find((m) => m.role === "system");
    assert.ok(sysMsg, "system message missing in payload");
    const content = String(sysMsg!.content);
    assert.equal(content, "BEFOREAFTER");
    assert.doesNotMatch(content, /CACHE_BOUNDARY/);
  });
});

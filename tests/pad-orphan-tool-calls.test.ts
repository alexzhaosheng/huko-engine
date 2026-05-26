/**
 * tests/pad-orphan-tool-calls.test.ts
 *
 * Pins the safety net that synthesises tool_result messages for any
 * assistant tool_call that lost its reply (page refresh during ask,
 * daemon crash mid-tool, etc.). Without this, providers (OpenAI/
 * Anthropic/DeepSeek) return 400 with
 *   "An assistant message with 'tool_calls' must be followed by
 *    tool messages responding to each 'tool_call_id'."
 *
 * The exact bug this targets:
 *   1. Agent calls message(type=ask) → assistant message persisted
 *      with toolCalls=[{id: "ask_1"}], task status "waiting_for_reply"
 *   2. Operator refreshes the page → UI loses ask state
 *   3. Operator sends a new chat message → new task starts and loads
 *      the session's LLM context, which contains the assistant
 *      message from (1) with NO matching tool_result
 *   4. Without this padding, the LLM call → 400
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { padOrphanToolCalls } from "../src/task/pipeline/pad-orphan-tool-calls.js";
import type { LLMMessage } from "../src/llm/types.js";

function asst(content: string, toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): LLMMessage {
  return { role: "assistant", content, ...(toolCalls ? { toolCalls } : {}) };
}
function tool(toolCallId: string, content: string): LLMMessage {
  return { role: "tool", content, toolCallId };
}
function user(content: string): LLMMessage {
  return { role: "user", content };
}

const SYNTH_RE = /no reply received.*abandoned/i;

// ─── happy path: nothing to pad ─────────────────────────────────────────────

describe("padOrphanToolCalls — no-op cases", () => {
  it("returns the same array reference when every tool_call is paired", () => {
    const messages: LLMMessage[] = [
      user("hi"),
      asst("", [{ id: "c1", name: "bash", arguments: { command: "ls" } }]),
      tool("c1", "file1\nfile2"),
      asst("Listed two files."),
    ];
    const out = padOrphanToolCalls(messages);
    assert.equal(out, messages, "same reference — no allocation in the happy path");
  });

  it("returns the same array when the assistant has no toolCalls at all", () => {
    const messages: LLMMessage[] = [user("hi"), asst("Hello.")];
    const out = padOrphanToolCalls(messages);
    assert.equal(out, messages);
  });

  it("returns the same array on empty input", () => {
    const messages: LLMMessage[] = [];
    const out = padOrphanToolCalls(messages);
    assert.equal(out, messages);
  });
});

// ─── core fix: page refresh during ask ──────────────────────────────────────

describe("padOrphanToolCalls — the user-reported bug", () => {
  it("synthesises a tool message after an unpaired ask tool_call", () => {
    // Simulates the entries left in the DB after the user refreshed
    // the page during message(type=ask) and the daemon's pending-ask
    // resolver died with the process.
    const messages: LLMMessage[] = [
      user("can you delete file.txt?"),
      asst("", [{
        id: "ask_1",
        name: "message",
        arguments: { type: "ask", text: "Should I delete file.txt?" },
      }]),
      // ← no tool_result for ask_1; operator never replied
      user("nevermind, do something else"),
    ];
    const out = padOrphanToolCalls(messages);
    assert.notEqual(out, messages, "must allocate a new array when padding is needed");
    assert.equal(out.length, 4, "one synthetic tool message inserted");
    // Padding goes RIGHT AFTER the assistant message, BEFORE the
    // next user message — provider needs the assistant-then-tool
    // adjacency.
    assert.equal(out[2]?.role, "tool");
    assert.equal(out[2]?.toolCallId, "ask_1");
    assert.match(out[2]!.content, SYNTH_RE);
    assert.equal(out[3]?.role, "user");
  });
});

// ─── multi-call assistant turn ──────────────────────────────────────────────

describe("padOrphanToolCalls — partial coverage", () => {
  it("pads ONLY the missing tool_calls when some are paired and some aren't", () => {
    // Assistant called three tools; only the second got a reply.
    const messages: LLMMessage[] = [
      user("do A, B, C"),
      asst("", [
        { id: "a", name: "x", arguments: {} },
        { id: "b", name: "x", arguments: {} },
        { id: "c", name: "x", arguments: {} },
      ]),
      tool("b", "B result"),
      user("status?"),
    ];
    const out = padOrphanToolCalls(messages);
    // Expect: [user, assistant, tool(b), tool(a synth), tool(c synth), user]
    assert.equal(out.length, 6);
    const toolMsgs = out.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 3);
    const ids = new Set(toolMsgs.map((m) => m.toolCallId));
    assert.deepEqual(ids, new Set(["a", "b", "c"]));
    // The non-synthetic one keeps its real content.
    const real = toolMsgs.find((m) => m.toolCallId === "b");
    assert.equal(real?.content, "B result");
    // The synthetic ones get the SYNTHETIC_REPLY text.
    for (const id of ["a", "c"]) {
      const synth = toolMsgs.find((m) => m.toolCallId === id);
      assert.match(synth!.content, SYNTH_RE);
    }
  });
});

// ─── ordering invariant ─────────────────────────────────────────────────────

describe("padOrphanToolCalls — ordering", () => {
  it("preserves the immediate adjacency between assistant and its tool block", () => {
    const messages: LLMMessage[] = [
      user("u1"),
      asst("", [{ id: "x", name: "n", arguments: {} }]),
      user("u2 — orphan, no reply was given"),
    ];
    const out = padOrphanToolCalls(messages);
    // out[0]=u1, out[1]=assistant, out[2]=synthetic tool, out[3]=u2
    assert.equal(out[0]?.role, "user");
    assert.equal(out[1]?.role, "assistant");
    assert.equal(out[2]?.role, "tool");
    assert.equal(out[3]?.role, "user");
  });

  it("handles multiple separate assistant turns each with their own padding need", () => {
    const messages: LLMMessage[] = [
      user("u1"),
      asst("", [{ id: "a1", name: "n", arguments: {} }]),
      // no tool for a1
      user("u2"),
      asst("", [{ id: "a2", name: "n", arguments: {} }]),
      // no tool for a2
      user("u3"),
    ];
    const out = padOrphanToolCalls(messages);
    // Expect: u1, asst-1, tool-a1-synth, u2, asst-2, tool-a2-synth, u3
    assert.equal(out.length, 7);
    assert.equal(out[2]?.toolCallId, "a1");
    assert.equal(out[5]?.toolCallId, "a2");
    for (const m of [out[2], out[5]]) assert.match(m!.content, SYNTH_RE);
  });
});

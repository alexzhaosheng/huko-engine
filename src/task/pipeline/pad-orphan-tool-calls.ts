/**
 * server/engine/task/pipeline/pad-orphan-tool-calls.ts
 *
 * Safety net for unpaired assistant tool_calls in the LLM context.
 *
 * Provider contract (OpenAI / Anthropic / DeepSeek / …): every
 * `assistant` message that carries `tool_calls` MUST be IMMEDIATELY
 * followed by `tool` messages — one per `tool_call.id` in the parent
 * assistant turn. Violating the pairing returns a 400 like:
 *
 *   {"error":{"message":"An assistant message with 'tool_calls' must
 *    be followed by tool messages responding to each 'tool_call_id'."}}
 *
 * Huko's normal flow always pairs them. The contract still breaks in
 * a few real-world scenarios where the pairing didn't make it to the
 * persistence layer:
 *
 *   1. The agent called `message(type=ask)` and the daemon crashed
 *      before the operator replied. `recoverOrphans` marks the task
 *      failed but doesn't synthesise a tool_result for the orphan
 *      tool_call (see server/engine/task/resume.ts). The next session load
 *      replays the unpaired call.
 *   2. The operator refreshed the web UI, never replied, then sent a
 *      new message. A new task starts; it loads the chat session's
 *      full history; the old task's unpaired ask tool_call is in
 *      there.
 *   3. Any future code path that fails to persist a tool_result for
 *      a persisted tool_call (network drop mid-stream, etc.).
 *
 * This helper walks the loaded LLMMessage array and, for every
 * assistant message with `toolCalls`, ensures each `toolCall.id` has
 * a `tool` message immediately after with matching `toolCallId`. If
 * any are missing, it inserts a synthetic `tool` message right after
 * the assistant entry, content explaining the missing reply. The LLM
 * sees a well-formed conversation and continues without the 400.
 *
 * Padding only on the IN-MEMORY message list — the DB stays
 * unchanged. The synthetic message is recomputed on every LLM call,
 * so a real tool_result that lands later (e.g. operator finally
 * replied to a recovered ask) supersedes it automatically.
 */

import type { LLMMessage } from "../../llm/types.js";

/** Content of the synthetic tool_result when no real reply exists. */
const SYNTHETIC_REPLY =
  "[no reply received — this tool call was abandoned (e.g. the user " +
  "refreshed the page during an ask, or a previous session ended " +
  "without responding). Treat this as a missing answer; if the " +
  "question is still relevant, ask again.]";

/**
 * Return `messages` augmented with synthetic `tool` entries for any
 * assistant `tool_calls` that lack a matching `tool` follow-up.
 *
 * Walk semantics:
 *   - For each assistant message with `toolCalls`, collect the set of
 *     expected `tool_call.id`s.
 *   - Look at the next contiguous run of `tool` messages and remove
 *     each call id whose `toolCallId` matches one of them.
 *   - Any leftover ids are unpaired; emit a synthetic tool message
 *     for each one, inserted RIGHT AFTER the existing tool block.
 *
 * Preserves the original array when nothing needs padding (same
 * reference returned — cheap no-op for the common case).
 */
export function padOrphanToolCalls(messages: LLMMessage[]): LLMMessage[] {
  // First pass: detect whether any padding is needed. Avoids
  // allocating a new array in the common case (every assistant turn
  // has its matching tool_results, which is the >99% path).
  if (!hasUnpairedToolCalls(messages)) return messages;

  const out: LLMMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i]!;
    out.push(m);
    if (m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) {
      i++;
      continue;
    }
    // Walk the contiguous run of `tool` messages following this
    // assistant turn, copying them through and noting which ids
    // they cover.
    const expected = new Set<string>();
    for (const tc of m.toolCalls) {
      if (tc.id) expected.add(tc.id);
    }
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === "tool") {
      const t = messages[j]!;
      out.push(t);
      if (t.toolCallId) expected.delete(t.toolCallId);
      j++;
    }
    // Any id left in `expected` was never paired — synthesise.
    for (const orphanId of expected) {
      out.push({
        role: "tool",
        content: SYNTHETIC_REPLY,
        toolCallId: orphanId,
      });
    }
    i = j;
  }
  return out;
}

/**
 * Cheap pre-check: does the message list contain at least one
 * unpaired assistant tool_call? Lets `padOrphanToolCalls` short-
 * circuit when nothing needs work and return the input by reference.
 */
function hasUnpairedToolCalls(messages: LLMMessage[]): boolean {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.toolCalls || m.toolCalls.length === 0) continue;
    const expected = new Set<string>();
    for (const tc of m.toolCalls) {
      if (tc.id) expected.add(tc.id);
    }
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === "tool") {
      const t = messages[j]!;
      if (t.toolCallId) expected.delete(t.toolCallId);
      j++;
    }
    if (expected.size > 0) return true;
  }
  return false;
}

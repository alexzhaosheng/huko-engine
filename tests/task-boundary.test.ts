/**
 * tests/task-boundary.test.ts
 *
 * Pins the contract of `injectTaskBoundaryReminder` — the helper
 * that splices a single per-call system_reminder into the LLM
 * message stream to keep the model from re-executing historical
 * tasks.
 *
 * Why this matters: huko had a recurring bug where the LLM would
 * pick up a completed/abandoned task from earlier in the
 * conversation and start redoing it. The fix is one transient
 * reminder placed just before the current task's first message;
 * these tests guard against the boundary creeping (e.g. accidentally
 * inserted before the user's latest message, which might be a
 * supplement to the current task).
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { injectTaskBoundaryReminder } from "../src/task/task-boundary.js";
import type { LLMMessage } from "../src/llm/types.js";

function msg(role: LLMMessage["role"], content: string, taskId?: number): LLMMessage {
  return {
    role,
    content,
    ...(taskId !== undefined ? { _taskId: taskId } : {}),
  };
}

const MARKER_RE = /<system_reminder reason="task_boundary">/;

// ─── happy path: prior task + current task ──────────────────────────────────

describe("injectTaskBoundaryReminder — splice point", () => {
  it("inserts the reminder JUST BEFORE the first message of the current task", () => {
    const messages: LLMMessage[] = [
      msg("user", "first task request", 1),
      msg("assistant", "doing first task", 1),
      msg("tool", "first task done", 1),
      msg("user", "second task request", 2),
      msg("assistant", "doing second task", 2),
    ];
    const out = injectTaskBoundaryReminder(messages, 2);
    // Reminder lands at index 3 (between the last entry of task 1
    // and the first entry of task 2).
    assert.equal(out.length, 6);
    assert.equal(out[3]?.role, "user");
    assert.match(out[3]!.content, MARKER_RE);
    // Original messages unchanged in order around the splice.
    assert.equal(out[2]?.content, "first task done");
    assert.equal(out[4]?.content, "second task request");
  });

  it("works for current task with multiple iterations (assistant + tool + assistant…)", () => {
    const messages: LLMMessage[] = [
      msg("user", "old task", 1),
      msg("assistant", "old answer", 1),
      msg("user", "current task", 2),
      msg("assistant", "thinking…", 2),
      msg("tool", "tool out 1", 2),
      msg("assistant", "more thinking", 2),
      msg("tool", "tool out 2", 2),
    ];
    const out = injectTaskBoundaryReminder(messages, 2);
    // ONE marker, placed before the first task-2 message (index 2).
    assert.equal(out.length, 8);
    const markerCount = out.filter((m) => MARKER_RE.test(m.content)).length;
    assert.equal(markerCount, 1, "exactly one marker even across multiple iterations of the current task");
    assert.match(out[2]!.content, MARKER_RE);
  });
});

// ─── no-op cases ────────────────────────────────────────────────────────────

describe("injectTaskBoundaryReminder — no-op cases", () => {
  it("returns messages unchanged when currentTaskId is undefined", () => {
    const messages: LLMMessage[] = [msg("user", "hi", 1)];
    const out = injectTaskBoundaryReminder(messages, undefined);
    assert.equal(out, messages, "same reference — no allocation when nothing to do");
  });

  it("returns messages unchanged on a fresh session (current task IS the first)", () => {
    // The current task's first message is at index 0 → nothing above
    // it to mark as historical → no marker.
    const messages: LLMMessage[] = [
      msg("user", "first ever request", 1),
      msg("assistant", "working on it", 1),
    ];
    const out = injectTaskBoundaryReminder(messages, 1);
    assert.equal(out.length, 2);
    assert.equal(out, messages, "unchanged when current task starts at index 0");
  });

  it("returns messages unchanged when no message belongs to the current task yet", () => {
    // Pre-first-turn state for the current task: history exists, but
    // the LLM call we're about to make IS the current task's first
    // entry. There's nothing in `messages` to splice before, so the
    // history flows through to the LLM untouched.
    const messages: LLMMessage[] = [
      msg("user", "old request", 1),
      msg("assistant", "old answer", 1),
    ];
    const out = injectTaskBoundaryReminder(messages, 2);
    assert.equal(out, messages);
  });

  it("returns messages unchanged for empty input", () => {
    const out = injectTaskBoundaryReminder([], 1);
    assert.deepEqual(out, []);
  });
});

// ─── shape & content of the reminder ────────────────────────────────────────

describe("injectTaskBoundaryReminder — marker shape", () => {
  it("uses role:user with the standard system_reminder XML wrapper", () => {
    const messages: LLMMessage[] = [
      msg("user", "old", 1),
      msg("user", "new", 2),
    ];
    const out = injectTaskBoundaryReminder(messages, 2);
    const marker = out[1]!;
    assert.equal(marker.role, "user");
    assert.match(marker.content, /^<system_reminder reason="task_boundary">/);
    assert.match(marker.content, /<\/system_reminder>$/);
  });

  it("the marker text is explicit about NOT re-executing prior tool calls", () => {
    const messages: LLMMessage[] = [
      msg("user", "old", 1),
      msg("user", "new", 2),
    ];
    const out = injectTaskBoundaryReminder(messages, 2);
    const marker = out[1]!;
    // Lock in the key instruction so a future edit that softens it
    // (e.g. "above is older context") doesn't silently regress the
    // protection.
    assert.match(marker.content, /historical reference/);
    assert.match(marker.content, /Do not re-execute prior tool calls/);
    assert.match(marker.content, /current task begins below/i);
  });

  it("does NOT pin the marker to 'the user's last message' (supplement-safe)", () => {
    // The user's most recent message inside the current task might be
    // a supplement ("now also handle Y"). The boundary marker must
    // sit at the START of the current task, NOT before the last user
    // message — otherwise the supplement gets cut off from its task.
    const messages: LLMMessage[] = [
      msg("user", "old task", 1),
      msg("user", "current task start", 2),
      msg("assistant", "starting on it", 2),
      msg("user", "supplement: now also do X", 2),
    ];
    const out = injectTaskBoundaryReminder(messages, 2);
    // Marker before "current task start" (index 1), NOT before the
    // supplement (index 3).
    assert.match(out[1]!.content, MARKER_RE);
    const markerCount = out.filter((m) => MARKER_RE.test(m.content)).length;
    assert.equal(markerCount, 1);
    // Verify the supplement is part of the current task's flow,
    // contiguous with its earlier messages — no marker between them.
    assert.equal(out[2]?.content, "current task start");
    assert.equal(out[3]?.content, "starting on it");
    assert.equal(out[4]?.content, "supplement: now also do X");
  });
});

// ─── interaction with compaction-elided history ─────────────────────────────

describe("injectTaskBoundaryReminder — compaction interaction", () => {
  it("ignores compaction-elided messages (they're not in input) and marks at the first visible current-task message", () => {
    // Simulated post-compaction state: half of task 1's messages were
    // elided by the adapter; only the surviving ones reach the helper.
    // The marker still goes between the last visible task-1 message
    // and the first task-2 message.
    const messages: LLMMessage[] = [
      // task 1's surviving compaction summary reminder (carries
      // _taskId=1 because that's the task that emitted it).
      msg("user", "<system_reminder reason=\"compaction_done\">…</system_reminder>", 1),
      msg("user", "current task", 2),
    ];
    const out = injectTaskBoundaryReminder(messages, 2);
    assert.equal(out.length, 3);
    assert.match(out[1]!.content, MARKER_RE);
    assert.equal(out[2]?.content, "current task");
  });
});

/**
 * server/engine/task/task-boundary.ts
 *
 * Per-call task-boundary reminder builder.
 *
 * Problem: when a chat session has accumulated several completed /
 * abandoned tasks, the LLM sometimes treats the historical exchanges
 * as the CURRENT task and starts re-executing finished work. The
 * symptom is "AI redoes the file edit I already saw it do, or
 * re-asks the question I already answered."
 *
 * Solution: at LLM-call prompt assembly time, splice ONE transient
 * `system_reminder` into the message stream just before the current
 * task's first message. The reminder is short, not persisted, and
 * carries a single instruction: everything above is history; the
 * current task starts here.
 *
 * Why one marker (not one per task boundary): we don't need the LLM
 * to disambiguate AMONG historical tasks — just to know which task
 * is current. A single "above is history" marker before the current
 * task's first message is enough. Cheaper too: ~30 tokens added per
 * call regardless of how many historical tasks the session has.
 *
 * Why "current task's first message" (not "the user's last message"):
 * the user's last message might be a supplement / follow-up to the
 * current task's earlier exchange ("now also handle X" / "actually
 * change Y to Z"). Marking "above last user message" would slice
 * the current task in half. Task boundaries respect the actual
 * orchestrator-managed task lifecycle.
 *
 * Why not persisted: the marker is computed from the current state
 * of (messages, currentTaskId). Persisting it would force a stale
 * marker on later replays when the active task has changed. Pure
 * prompt-time injection always reflects the live state.
 */

import type { LLMMessage } from "../llm/types.js";

/**
 * Return the LLM-message list with a single task-boundary reminder
 * spliced in just before the first message of `currentTaskId`.
 *
 * Returns `messages` unchanged when:
 *   - `currentTaskId` is undefined / null (no current task — shouldn't
 *     happen mid-call but defensive)
 *   - the current task's first message is at index 0 (no prior tasks
 *     to mark as historical — fresh session or first task)
 *   - no message in `messages` has `_taskId === currentTaskId` (the
 *     current task hasn't produced its first entry yet; the upcoming
 *     LLM call IS that first entry — the LLM will receive only
 *     history + system prompt, which is fine: there's no current-task
 *     content to compete with history)
 *
 * The marker is a `user`-role message wrapping a
 * `<system_reminder reason="task_boundary">…</system_reminder>` XML
 * block — same convention every other system_reminder in huko uses
 * (system prompt teaches the model to read those tags as kernel
 * directives, not user input).
 */
export function injectTaskBoundaryReminder(
  messages: LLMMessage[],
  currentTaskId: number | undefined,
): LLMMessage[] {
  if (currentTaskId === undefined) return messages;

  // Find the first message that belongs to the current task. The
  // adapter projects `row.taskId` to `_taskId` on every message;
  // messages without `_taskId` (a hypothetical synthetic message
  // injected outside the entry pipeline) get skipped here, which is
  // the right behaviour — they have no task affiliation.
  let firstCurrentIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?._taskId === currentTaskId) {
      firstCurrentIdx = i;
      break;
    }
  }

  // Nothing to mark: either current task already starts at 0
  // (no history before it), or no message yet belongs to current
  // task (LLM call is the first turn of the current task).
  if (firstCurrentIdx <= 0) return messages;

  const reminder: LLMMessage = {
    role: "user",
    content:
      `<system_reminder reason="task_boundary">` +
      `The conversation above is historical reference from previous tasks (completed or abandoned). ` +
      `Your current task begins below this marker. ` +
      `Do not re-execute prior tool calls or treat completed work as a current request.` +
      `</system_reminder>`,
  };

  return [
    ...messages.slice(0, firstCurrentIdx),
    reminder,
    ...messages.slice(firstCurrentIdx),
  ];
}

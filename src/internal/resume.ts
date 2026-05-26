/**
 * Engine-internal orphan recovery — runs automatically at engine
 * construction. Scans for tasks in non-terminal status (left over
 * from a crashed / killed previous process) and heals them so future
 * LLM calls on the same session don't choke on broken history.
 *
 * @internal — `createHukoEngine` invokes this for you. Hosts never
 * call it directly. Visibility into what got recovered flows back
 * through `HukoEngineOptions.onOrphanRecovered`.
 *
 * Three checkpoint shapes:
 *
 *   1. `status = "running"` with dangling tool_calls
 *      The LLM emitted assistant(toolCalls=[...]) and the process
 *      died before tool_results landed. Anthropic / OpenAI / Gemini
 *      will all 400 the next conversation if a tool_use has no
 *      matching tool_result.
 *      → Inject synthetic tool_result rows (one per dangling callId)
 *        with content "Error: tool execution interrupted by process
 *        termination." Pairing constraint preserved.
 *      → Mark task `status = "failed"`.
 *
 *   2. `status = "waiting_for_reply"`
 *      Task paused on `message --type=ask`. The user never replied
 *      before the process died.
 *      → Mark task `status = "failed"`. (Future: re-emit the ask
 *        event so the next process can pick up the prompt.)
 *
 *   3. `status = "waiting_for_approval"`
 *      Task paused awaiting `requestApproval`. Same shape as #2.
 *      → Mark task `status = "failed"`.
 *
 * What we do NOT do:
 *   - Reconstruct TaskContext and continue the loop. That requires
 *     re-resolving model config + tools + executors — for huko's
 *     embedding shape, the simpler "mark failed, repair pairing" is
 *     enough. The user can start a new turn on the same session and
 *     the synthetic tool_results keep history valid.
 *   - Periodic re-scan. Startup-once is sufficient.
 *
 * Recovery requires the persistence implementation to expose
 * `listNonTerminalTasks` + `listEntriesForSession` (both optional on
 * AgentPersistence). When either is missing the scan is skipped
 * silently — MemoryAgentPersistence is the typical no-op case
 * (in-memory state can't survive a crash).
 */

import { EntryKind, type SessionType, type TaskStatus } from "../shared/types.js";
import type {
  AgentPersistence,
  RecoverableEntryRow,
  RecoverableTaskRow,
} from "../persistence/agent-persistence.js";

export type OrphanRecord = {
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  /** Short reason: e.g. "process exited mid-tool" / "process exited while waiting for user reply". */
  reason: string;
  /** How many synthetic tool_result rows were injected for pairing. 0 if none needed. */
  danglingToolCount: number;
};

export type RecoveryReport = {
  scanned: number;
  healed: number;
  byKind: {
    danglingTools: number;
    waitingForReply: number;
    waitingForApproval: number;
    other: number;
  };
  /** Per-task detail, one entry per healed task. Surfaced via `onOrphanRecovered`. */
  records: OrphanRecord[];
};

/** Empty report — returned when persistence doesn't support the scan. */
export const EMPTY_RECOVERY_REPORT: RecoveryReport = {
  scanned: 0,
  healed: 0,
  byKind: {
    danglingTools: 0,
    waitingForReply: 0,
    waitingForApproval: 0,
    other: 0,
  },
  records: [],
};

/**
 * Scan persistence for orphan tasks and heal them. Idempotent —
 * running twice is safe (second run finds nothing).
 *
 * Returns an empty report when the persistence implementation
 * doesn't expose `listNonTerminalTasks` (engine signals "recovery
 * not supported"). When `listEntriesForSession` is also absent, the
 * scan still marks tasks failed but skips dangling-tool-result
 * synthesis (recovery report still flows, just without per-entry
 * detail).
 */
export async function recoverOrphans(
  persistence: AgentPersistence,
): Promise<RecoveryReport> {
  if (!persistence.listNonTerminalTasks) return EMPTY_RECOVERY_REPORT;

  const report: RecoveryReport = {
    scanned: 0,
    healed: 0,
    byKind: {
      danglingTools: 0,
      waitingForReply: 0,
      waitingForApproval: 0,
      other: 0,
    },
    records: [],
  };

  const orphans = await persistence.listNonTerminalTasks();
  report.scanned = orphans.length;

  for (const task of orphans) {
    const sessionType: SessionType =
      task.chatSessionId !== null ? "chat" : "agent";
    const sessionId = task.chatSessionId ?? task.agentSessionId;
    if (sessionId === null) {
      const reason = "orphan task has no session";
      await markFailed(persistence, task, reason);
      report.byKind.other += 1;
      report.healed += 1;
      report.records.push({
        taskId: task.id,
        sessionId: 0,
        sessionType,
        reason,
        danglingToolCount: 0,
      });
      continue;
    }

    if (task.status === "waiting_for_reply") {
      const reason = "process exited while waiting for user reply";
      await markFailed(persistence, task, reason);
      report.byKind.waitingForReply += 1;
      report.healed += 1;
      report.records.push({
        taskId: task.id,
        sessionId,
        sessionType,
        reason,
        danglingToolCount: 0,
      });
      continue;
    }
    if (task.status === "waiting_for_approval") {
      const reason = "process exited while waiting for approval";
      await markFailed(persistence, task, reason);
      report.byKind.waitingForApproval += 1;
      report.healed += 1;
      report.records.push({
        taskId: task.id,
        sessionId,
        sessionType,
        reason,
        danglingToolCount: 0,
      });
      continue;
    }

    // "running" / "pending" — scan for dangling tool_calls + synthesise
    // tool_results so the conversation stays valid for any future
    // continue-conversation call.
    let dangling: string[] = [];
    if (persistence.listEntriesForSession) {
      const entries = await persistence.listEntriesForSession(
        sessionId,
        sessionType,
      );
      const taskEntries = entries.filter((e) => e.taskId === task.id);
      dangling = findDanglingToolCalls(taskEntries);

      for (const callId of dangling) {
        await persistence.persist({
          taskId: task.id,
          sessionId,
          sessionType,
          kind: EntryKind.ToolResult,
          role: "tool",
          content:
            "Error: tool execution was interrupted by process termination. " +
            "The result is unknown. (Synthesised by orphan recovery.)",
          toolCallId: callId,
          thinking: null,
          metadata: {
            toolName: "(unknown)",
            error: "interrupted",
            synthetic: true,
            source: "engine/recovery",
          },
        });
      }
    }

    if (dangling.length > 0) report.byKind.danglingTools += 1;
    else report.byKind.other += 1;

    const reason =
      dangling.length > 0
        ? `process exited mid-tool; ${dangling.length} synthetic tool_result(s) injected for pairing`
        : "process exited while running; no dangling tool_calls";
    await markFailed(persistence, task, reason);
    report.healed += 1;
    report.records.push({
      taskId: task.id,
      sessionId,
      sessionType,
      reason,
      danglingToolCount: dangling.length,
    });
  }

  return report;
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function markFailed(
  persistence: AgentPersistence,
  task: RecoverableTaskRow,
  reason: string,
): Promise<void> {
  const patch: { status: TaskStatus; errorMessage: string } = {
    status: "failed",
    errorMessage: reason,
  };
  await persistence.updateTask(task.id, patch);
}

/**
 * Walk a task's entries in chronological order. For each
 * `ai_message` whose metadata carries `toolCalls`, register all those
 * call ids as "open". For each `tool_result` with a matching
 * `toolCallId`, close it. Anything still open at the end is dangling.
 *
 * Skips entries that don't carry tool semantics — only `ai_message`
 * (the assistant turn) and `tool_result` matter.
 */
function findDanglingToolCalls(entries: RecoverableEntryRow[]): string[] {
  const open = new Map<string, true>();

  for (const e of entries) {
    if (e.kind === EntryKind.AiMessage) {
      const tcs = e.metadata?.["toolCalls"] as Array<{ id?: string }> | undefined;
      if (tcs) {
        for (const tc of tcs) {
          if (tc && typeof tc.id === "string") open.set(tc.id, true);
        }
      }
    } else if (e.kind === EntryKind.ToolResult && e.toolCallId) {
      open.delete(e.toolCallId);
    }
  }

  return [...open.keys()];
}

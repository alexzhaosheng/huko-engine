/**
 * AgentPersistence — the minimal persistence contract the engine's
 * upcoming facade (`createHukoEngine` / `agent.runTurn(...)`) requires
 * from a host.
 *
 * Six methods, plus close. Anything richer (listing sessions for a
 * UI, scheduled-task hooks, resume of non-terminal tasks across
 * restarts, redaction substitutions) lives in the host — those wrap
 * or extend an AgentPersistence, they don't widen the engine's
 * contract.
 *
 * The engine ships two implementations in this folder:
 *   - SqliteAgentPersistence — production-ready, better-sqlite3
 *   - MemoryAgentPersistence — tests + short-lived agents
 *
 * Hosts may implement their own (remote storage, multi-tenant
 * sharded DB, custom audit hooks); the conformance test suite
 * (packages/huko-engine/tests/agent-persistence.test.ts) is parametrized
 * so any new impl can be plugged into the same battery.
 *
 * Why not the larger 19-method `SessionPersistence` interface that
 * cli already has? That one is cli's product-specific extension —
 * scheduler-owned sessions, redaction substitutions, resume UI
 * surface, etc. The engine doesn't need those to run an agent. A
 * narrow surface is what lets future hosts implement the contract
 * without re-implementing cli's product features.
 */

import type { PersistFn, UpdateFn } from "../internal/SessionContext.js";
import type { LLMMessage, ThinkLevel, ToolCallMode } from "../llm/types.js";
import type { EntryKind, SessionType, TaskStatus } from "../shared/types.js";

/**
 * Re-export the SessionContext callback types so host persistence
 * implementations (cli's drizzle adapter, custom storage backends)
 * can name them via the public persistence subpath instead of
 * reaching into `internal/SessionContext.js`. The types are part of
 * `AgentPersistence.persist` / `AgentPersistence.update` — naming
 * them here keeps the public-facing contract self-contained.
 */
export type { PersistFn, UpdateFn };

// ─── Inputs ─────────────────────────────────────────────────────────────────

export type CreateSessionInput = {
  title?: string;
  /** Defaults to "chat". "scheduled" reserved for cron-owned sessions. */
  kind?: "chat" | "scheduled";
  /** Required when kind === "scheduled" — the schedule's stable id. */
  scheduleId?: string;
};

export type CreateTaskInput = {
  chatSessionId: number | null;
  agentSessionId?: number | null;
  modelId: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  /** Defaults to "running" when the implementation supports it. */
  status?: TaskStatus;
};

/**
 * Shape of an entry persisted atomically alongside a freshly created
 * task — same fields as `PersistFn` minus `taskId` (the implementation
 * fills it from the task INSERT). Used by the optional
 * `createTaskWithInitialEntry` hook.
 */
export type InitialEntryInput = {
  sessionId: number;
  sessionType: SessionType;
  kind: EntryKind;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string | null;
  thinking?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type CreateTaskWithInitialEntryInput = {
  task: CreateTaskInput;
  entry: InitialEntryInput;
};

export type UpdateTaskPatch = {
  status?: TaskStatus;
  finalResult?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCallCount?: number;
  iterationCount?: number;
  errorMessage?: string;
};

// ─── Optional recovery surface ──────────────────────────────────────────────

/**
 * Minimum task fields the engine's orphan-recovery scan needs. A
 * subset of the wider TaskRow that cli's SessionPersistence returns.
 */
export type RecoverableTaskRow = {
  id: number;
  chatSessionId: number | null;
  agentSessionId: number | null;
  status: TaskStatus;
};

/**
 * Minimum entry fields recovery walks to find dangling tool_calls.
 */
export type RecoverableEntryRow = {
  id: number;
  taskId: number;
  kind: EntryKind;
  role: "system" | "user" | "assistant" | "tool";
  toolCallId: string | null;
  metadata: Record<string, unknown> | null;
};

// ─── Interface ──────────────────────────────────────────────────────────────

export interface AgentPersistence {
  /**
   * Engine's `PersistFn`. Inserts one entry, returns its row id.
   * Called from inside SessionContext.append on every turn step.
   */
  persist: PersistFn;

  /**
   * Engine's `UpdateFn`. Patches an existing entry. `mergeMetadata`
   * (default off) shallow-merges into stored metadata JSON; engine
   * uses this for token-usage rollups on assistant entries.
   */
  update: UpdateFn;

  /**
   * Replay this session's persisted entries as LLMMessages — the
   * shape `SessionContext` takes as `initialContext` when resuming.
   * Implementations must filter out entries that are NOT LLM-visible
   * (use engine's `isLLMVisible(kind)` helper). Order: oldest first.
   */
  loadInitialContext(
    sessionId: number,
    sessionType: SessionType,
  ): Promise<LLMMessage[]>;

  /**
   * Create a chat session row. Returns its id. The facade uses this
   * the first time an agent encounters a new conversation.
   */
  createSession(input: CreateSessionInput): Promise<number>;

  /**
   * Create a task row tied to one session. Returns its id. The facade
   * calls this once per turn at task spinup, then threads the id
   * through SessionContext + TaskContext so every entry gets a
   * task_id and every event carries the right correlation.
   */
  createTask(input: CreateTaskInput): Promise<number>;

  /**
   * Patch a task row — status transitions and usage counters at task
   * completion. Implementations should treat missing fields as
   * unchanged.
   */
  updateTask(id: number, patch: UpdateTaskPatch): Promise<void>;

  /**
   * Optional atomic "create the task row AND persist its initial entry
   * in one transaction" hook. Daemons that recover from mid-task
   * crashes (e.g. cli) rely on this to avoid the "task row exists but
   * its first user message is missing" ghost state.
   *
   * Implementations that don't support transactions can omit this; the
   * facade falls back to a two-step createTask + persist, which is fine
   * for short-lived embedding hosts (HTTP request handlers, tests).
   *
   * Returns both the new task id and the new entry id; the facade
   * passes `entryId` to SessionContext.append as `knownEntryId` so the
   * in-memory llmContext + event bus update without a redundant DB
   * write.
   */
  createTaskWithInitialEntry?(
    input: CreateTaskWithInitialEntryInput,
  ): Promise<{ taskId: number; entryId: number }>;

  /**
   * Optional: list every task whose status is NOT terminal (i.e. NOT
   * `done` / `failed` / `stopped`). Used by the engine's automatic
   * orphan-recovery scan at construction time — when the engine
   * starts up and finds tasks left in non-terminal state from a
   * crashed previous run, it marks them failed and (when
   * `listEntriesForSession` is also implemented) injects synthetic
   * tool_results to keep conversation history paired so any future
   * session continuation doesn't 400 on strict providers.
   *
   * Implementations without this method opt out of recovery — the
   * engine skips the scan silently. MemoryAgentPersistence omits it
   * (in-memory state can't survive a crash anyway). SQLite + cli's
   * adapter implement it.
   */
  listNonTerminalTasks?(): Promise<RecoverableTaskRow[]>;

  /**
   * Optional: list every entry tied to one (sessionId, sessionType)
   * pair, in chronological order. Paired with `listNonTerminalTasks`
   * — the orphan scan walks these to detect dangling tool_calls (the
   * "assistant emitted a tool_call but the process died before the
   * tool_result landed" case).
   *
   * If absent (or `listNonTerminalTasks` is absent), the engine still
   * marks orphan tasks failed but skips the dangling-tool-result
   * synthesis step — the next conversation continuation may then 400
   * on strict providers. Implement both for full recovery.
   */
  listEntriesForSession?(
    sessionId: number,
    sessionType: SessionType,
  ): Promise<RecoverableEntryRow[]>;

  /**
   * Release any underlying resources (file handles, in-flight writes).
   * Idempotent — calling close on an already-closed instance is a
   * no-op, not an error.
   */
  close(): Promise<void> | void;
}

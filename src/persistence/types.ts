/**
 * server/engine/persistence/types.ts
 *
 * `SessionPersistence` — per-project conversation state at
 * `<cwd>/.huko/huko.db`: chat_sessions, tasks, the LLM-visible entry
 * log. Drop a project, drop its `.huko/`, and the conversations go
 * with it.
 *
 * Provider/model/system-default config used to live in a sibling
 * `InfraPersistence` (SQLite). It moved to layered JSON files —
 * see `server/config/infra-config.ts`. The interface is gone; the
 * row shapes too.
 *
 * Plaintext API keys are NEVER stored here. See `server/security/keys.ts`.
 *
 * Atomicity contract (see persistence.md):
 *   - Single-row writes are atomic (SQLite per-statement).
 *   - Task lifecycle's "create task + persist initial entry" is atomic
 *     via `tasks.createWithInitialEntry` (one transaction). The
 *     orchestrator uses this to avoid the "task row but no user
 *     message" ghost state under crash.
 *   - Multi-step lifecycle further out (assistant turn + tool_results)
 *     is NOT transactional; resume/orphan recovery is the answer.
 *
 * SessionContext keeps its existing `PersistFn` / `UpdateFn` function-shape
 * dependency. Orchestrator destructures them out of `session.entries` at
 * SessionContext construction time.
 */

import type { LLMMessage } from "../llm/types.js";
import type { ThinkLevel, ToolCallMode } from "../llm/types.js";
import type { EntryKind, SessionType, TaskStatus } from "../shared/types.js";
import type { PersistFn, UpdateFn } from "../internal/SessionContext.js";

// ─── Row shapes (what queries return) ────────────────────────────────────────

/**
 * `chat_sessions` hosts two flavours: regular operator chat
 * (`kind='chat'`) and the long-lived sessions owned by scheduled-task
 * files (`kind='scheduled'`, `scheduleId` = filename stem). See
 * migration 0003 for why we share the table.
 */
export type SessionKind = "chat" | "scheduled";

export type ChatSessionRow = {
  id: number;
  title: string;
  kind: SessionKind;
  scheduleId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type TaskRow = {
  id: number;
  chatSessionId: number | null;
  agentSessionId: number | null;
  status: TaskStatus;
  modelId: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCallCount: number;
  iterationCount: number;
  finalResult: string;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export type EntryRow = {
  id: number;
  taskId: number;
  sessionId: number;
  sessionType: SessionType;
  kind: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId: string | null;
  thinking: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
};

// ─── Inputs ──────────────────────────────────────────────────────────────────

export type CreateChatSessionInput = {
  title?: string;
  /** Defaults to `"chat"`. Set to `"scheduled"` for cron-owned sessions. */
  kind?: SessionKind;
  /** Required iff kind='scheduled' — the schedule filename stem. */
  scheduleId?: string;
};

export type CreateTaskInput = {
  chatSessionId: number | null;
  agentSessionId: number | null;
  modelId: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  status?: TaskStatus;
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

/**
 * The shape of an entry to persist atomically alongside a freshly
 * created task. Identical to `PersistFn`'s parameter except `taskId`
 * is omitted — the implementation fills it in after the task INSERT.
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

// ─── SessionPersistence — per-project DB ─────────────────────────────────────

export interface SessionPersistence {
  readonly entries: {
    persist: PersistFn;
    update: UpdateFn;
    /**
     * Replay the LLM-visible history of a session into LLMMessages.
     * Already filters out entries elided by previous compactions.
     */
    loadLLMContext(sessionId: number, type: SessionType): Promise<LLMMessage[]>;
    listForSession(sessionId: number, type: SessionType): Promise<EntryRow[]>;
  };

  readonly sessions: {
    create(input: CreateChatSessionInput): Promise<number>;
    list(): Promise<ChatSessionRow[]>;
    get(id: number): Promise<ChatSessionRow | null>;
    /**
     * Look up the scheduled-session row owned by `scheduleId` (filename
     * stem of `.huko/schedules/<name>.md`). Returns null when this
     * schedule has not run yet — the scheduler then creates one. Uses
     * the unique partial index from migration 0003 (`schedule_id IS
     * NOT NULL`), so this is a single indexed lookup.
     */
    findByScheduleId(scheduleId: string): Promise<ChatSessionRow | null>;
    update(id: number, patch: { title: string }): Promise<void>;
    delete(id: number): Promise<void>;
  };

  readonly tasks: {
    create(input: CreateTaskInput): Promise<number>;
    /**
     * Atomic: create the task row AND persist its initial entry in
     * one transaction. Used at task spinup to avoid the "task created
     * but user message lost" ghost state if the process dies between
     * two separate inserts.
     *
     * Returns both the new task id and the new entry id. Callers
     * (orchestrator) then notify SessionContext via
     * `append(payload, { knownEntryId })` to emit the event and update
     * the in-memory llmContext WITHOUT a redundant DB write.
     */
    createWithInitialEntry(
      input: CreateTaskWithInitialEntryInput,
    ): Promise<{ taskId: number; entryId: number }>;
    update(id: number, patch: UpdateTaskPatch): Promise<void>;
    get(id: number): Promise<TaskRow | null>;
    /**
     * List every task whose status is NOT terminal (i.e. not `done` /
     * `failed` / `stopped`). Used by resume / orphan recovery at startup.
     */
    listNonTerminal(): Promise<TaskRow[]>;
    /**
     * Most recent task in a terminal state (`done` / `failed` / `stopped`)
     * for the given chat session, or null when the session has never
     * completed a task. Scheduled-task triggers use this to inject the
     * previous run's `finalResult` into the new task's trigger user
     * message — the cross-run continuity hook for stateful schedules.
     *
     * Ordered by `createdAt DESC` (== completion order in practice,
     * since tasks created later finish later).
     */
    getLatestTerminalForSession(chatSessionId: number): Promise<TaskRow | null>;
  };

  /**
   * Per-session secret-substitution table — backs Layers 2/3 of the
   * redaction system (vault hits + auto-discovered regex hits).
   *
   * Each row maps a placeholder ([REDACTED:github-token]` or
   * `[REDACTED:secret-3]`) to its raw value. The scrubber writes here
   * when it finds a new secret outbound; tool-execute reads here when
   * a placeholder appears in tool args (expand back to raw before
   * running the tool). Scoped to (sessionId, sessionType) so secrets
   * never bleed between sessions.
   */
  readonly substitutions: {
    /**
     * Insert a (placeholder, rawValue) mapping. Idempotent: if the same
     * placeholder already exists with the same value, no-op. If the
     * placeholder exists with a DIFFERENT value, that's a bug in the
     * caller (placeholder allocation should be deterministic for a
     * given raw value within a session) — implementations may throw.
     */
    record(input: SubstitutionRecord): Promise<void>;
    /** Look up the raw value for a placeholder, or null if unknown. */
    lookupByPlaceholder(
      sessionId: number,
      sessionType: SessionType,
      placeholder: string,
    ): Promise<string | null>;
    /**
     * Look up the placeholder previously assigned to `rawValue`, or
     * null if this is a fresh secret. Used by the scrubber for
     * idempotence (same secret in two outbound messages → same
     * placeholder, so the LLM sees stable references).
     */
    lookupByRaw(
      sessionId: number,
      sessionType: SessionType,
      rawValue: string,
    ): Promise<string | null>;
    /** All substitutions for a session — diagnostics + tests. */
    listForSession(
      sessionId: number,
      sessionType: SessionType,
    ): Promise<SubstitutionRow[]>;
  };

  /** Graceful shutdown — close connections, flush WAL, etc. */
  close(): Promise<void> | void;
}

// ─── Session substitutions (redaction layer) ─────────────────────────────────

export type SubstitutionSource =
  | "vault"
  | `scrub:${string}`; // e.g. "scrub:openai-key"

export type SubstitutionRecord = {
  sessionId: number;
  sessionType: SessionType;
  placeholder: string;
  rawValue: string;
  source: SubstitutionSource;
};

export type SubstitutionRow = SubstitutionRecord & {
  createdAt: number;
};

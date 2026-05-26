/**
 * SqliteAgentPersistence — production-ready `AgentPersistence`
 * backed by better-sqlite3.
 *
 * Owns:
 *   - Opening / creating the SQLite file (parent dirs auto-created).
 *   - WAL pragma + foreign keys ON.
 *   - Schema migration on construction (idempotent CREATE TABLE IF NOT
 *     EXISTS). The schema is stable and additive — new fields land via
 *     `ALTER TABLE` patches inside `applySchema`, never DROP COLUMN.
 *   - Engine's `persist` / `update` callbacks.
 *   - `loadInitialContext` that replays LLM-visible entries.
 *   - Session + task CRUD the facade needs.
 *
 * Schema (three tables):
 *   sessions(id, title, kind, schedule_id, created_at, updated_at)
 *   tasks(id, chat_session_id, agent_session_id, status, model_id,
 *         tool_call_mode, think_level, prompt_tokens, completion_tokens,
 *         total_tokens, tool_call_count, iteration_count, final_result,
 *         error_message, created_at, updated_at)
 *   entries(id, task_id, session_id, session_type, kind, role, content,
 *           tool_call_id, thinking, metadata, created_at)
 *
 * Atomicity contract:
 *   - Single-row writes are atomic (SQLite per-statement).
 *   - The engine treats writes as fire-and-forget from inside
 *     SessionContext; orphan recovery on restart is a host concern
 *     (not implemented here — see cli's SessionPersistence for that
 *     extended surface).
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

import type { PersistFn, UpdateFn } from "../internal/SessionContext.js";
import type { LLMMessage } from "../llm/types.js";
import {
  isLLMVisible,
  type EntryKind,
  type SessionType,
  type TaskStatus,
} from "../shared/types.js";

import type {
  AgentPersistence,
  CreateSessionInput,
  CreateTaskInput,
  CreateTaskWithInitialEntryInput,
  RecoverableEntryRow,
  RecoverableTaskRow,
  UpdateTaskPatch,
} from "./agent-persistence.js";

export class SqliteAgentPersistence implements AgentPersistence {
  readonly db: Database.Database;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.applySchema();
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'chat',
        schedule_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_session_id INTEGER,
        agent_session_id INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        model_id TEXT NOT NULL,
        tool_call_mode TEXT NOT NULL,
        think_level TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        iteration_count INTEGER NOT NULL DEFAULT 0,
        final_result TEXT NOT NULL DEFAULT '',
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (chat_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(chat_session_id);

      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        session_id INTEGER NOT NULL,
        session_type TEXT NOT NULL,
        kind TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        thinking TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_entries_session ON entries(session_id, session_type, id);
      CREATE INDEX IF NOT EXISTS idx_entries_task ON entries(task_id);
    `);
  }

  // ── Engine callbacks ─────────────────────────────────────────────────────

  readonly persist: PersistFn = async (entry) => {
    const metadataJson = entry.metadata != null ? JSON.stringify(entry.metadata) : null;
    const result = this.db
      .prepare(
        `INSERT INTO entries (
           task_id, session_id, session_type, kind, role, content,
           tool_call_id, thinking, metadata, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.taskId,
        entry.sessionId,
        entry.sessionType,
        entry.kind,
        entry.role,
        entry.content,
        entry.toolCallId ?? null,
        entry.thinking ?? null,
        metadataJson,
        Date.now(),
      );
    return Number(result.lastInsertRowid);
  };

  readonly update: UpdateFn = async (entryId, patch) => {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (patch.content !== undefined) {
      fields.push("content = ?");
      values.push(patch.content);
    }
    if (patch.metadata !== undefined) {
      let metadataJson: string;
      if (patch.mergeMetadata) {
        const existing = this.readEntryMetadata(entryId);
        metadataJson = JSON.stringify({ ...existing, ...patch.metadata });
      } else {
        metadataJson = JSON.stringify(patch.metadata);
      }
      fields.push("metadata = ?");
      values.push(metadataJson);
    }

    if (fields.length === 0) return;
    values.push(entryId);
    this.db
      .prepare(`UPDATE entries SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
  };

  private readEntryMetadata(entryId: number): Record<string, unknown> {
    const row = this.db
      .prepare(`SELECT metadata FROM entries WHERE id = ?`)
      .get(entryId) as { metadata: string | null } | undefined;
    if (!row || !row.metadata) return {};
    try {
      return JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  async loadInitialContext(
    sessionId: number,
    sessionType: SessionType,
  ): Promise<LLMMessage[]> {
    type Row = {
      kind: string;
      role: "system" | "user" | "assistant" | "tool";
      content: string;
      toolCallId: string | null;
    };

    const rows = this.db
      .prepare(
        `SELECT kind, role, content, tool_call_id AS toolCallId
         FROM entries
         WHERE session_id = ? AND session_type = ?
         ORDER BY id ASC`,
      )
      .all(sessionId, sessionType) as Row[];

    const messages: LLMMessage[] = [];
    for (const row of rows) {
      if (!isLLMVisible(row.kind as EntryKind)) continue;
      if (row.role === "tool") {
        messages.push({
          role: "tool",
          content: row.content,
          ...(row.toolCallId !== null ? { tool_call_id: row.toolCallId } : {}),
        });
      } else {
        messages.push({ role: row.role, content: row.content });
      }
    }
    return messages;
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<number> {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO sessions (title, kind, schedule_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.title ?? "",
        input.kind ?? "chat",
        input.scheduleId ?? null,
        now,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  async createTask(input: CreateTaskInput): Promise<number> {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO tasks (
           chat_session_id, agent_session_id, status, model_id, tool_call_mode, think_level,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.chatSessionId,
        input.agentSessionId ?? null,
        input.status ?? "running",
        input.modelId,
        input.toolCallMode,
        input.thinkLevel,
        now,
        now,
      );
    return Number(result.lastInsertRowid);
  }

  async createTaskWithInitialEntry(
    input: CreateTaskWithInitialEntryInput,
  ): Promise<{ taskId: number; entryId: number }> {
    const now = Date.now();
    const tx = this.db.transaction(
      (taskIn: CreateTaskInput, entryIn: typeof input.entry) => {
        const taskRes = this.db
          .prepare(
            `INSERT INTO tasks (
               chat_session_id, agent_session_id, status, model_id, tool_call_mode, think_level,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            taskIn.chatSessionId,
            taskIn.agentSessionId ?? null,
            taskIn.status ?? "running",
            taskIn.modelId,
            taskIn.toolCallMode,
            taskIn.thinkLevel,
            now,
            now,
          );
        const taskId = Number(taskRes.lastInsertRowid);
        const metadataJson =
          entryIn.metadata != null ? JSON.stringify(entryIn.metadata) : null;
        const entryRes = this.db
          .prepare(
            `INSERT INTO entries (
               task_id, session_id, session_type, kind, role, content,
               tool_call_id, thinking, metadata, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            taskId,
            entryIn.sessionId,
            entryIn.sessionType,
            entryIn.kind,
            entryIn.role,
            entryIn.content,
            entryIn.toolCallId ?? null,
            entryIn.thinking ?? null,
            metadataJson,
            now,
          );
        return { taskId, entryId: Number(entryRes.lastInsertRowid) };
      },
    );
    return tx(input.task, input.entry);
  }

  async updateTask(id: number, patch: UpdateTaskPatch): Promise<void> {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, col] of [
      ["status", "status"],
      ["finalResult", "final_result"],
      ["promptTokens", "prompt_tokens"],
      ["completionTokens", "completion_tokens"],
      ["totalTokens", "total_tokens"],
      ["toolCallCount", "tool_call_count"],
      ["iterationCount", "iteration_count"],
      ["errorMessage", "error_message"],
    ] as const) {
      const v = (patch as Record<string, unknown>)[key];
      if (v !== undefined) {
        fields.push(`${col} = ?`);
        values.push(v);
      }
    }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);
    this.db
      .prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`)
      .run(...values);
  }

  // ── Recovery (engine's orphan-scan opt-in) ───────────────────────────────

  async listNonTerminalTasks(): Promise<RecoverableTaskRow[]> {
    type Row = {
      id: number;
      chatSessionId: number | null;
      agentSessionId: number | null;
      status: string;
    };
    const rows = this.db
      .prepare(
        `SELECT id, chat_session_id AS chatSessionId,
                agent_session_id AS agentSessionId, status
         FROM tasks
         WHERE status NOT IN ('done', 'failed', 'stopped')`,
      )
      .all() as Row[];
    return rows.map((r) => ({
      id: r.id,
      chatSessionId: r.chatSessionId,
      agentSessionId: r.agentSessionId,
      status: r.status as TaskStatus,
    }));
  }

  async listEntriesForSession(
    sessionId: number,
    sessionType: SessionType,
  ): Promise<RecoverableEntryRow[]> {
    type Row = {
      id: number;
      taskId: number;
      kind: string;
      role: "system" | "user" | "assistant" | "tool";
      toolCallId: string | null;
      metadata: string | null;
    };
    const rows = this.db
      .prepare(
        `SELECT id, task_id AS taskId, kind, role,
                tool_call_id AS toolCallId, metadata
         FROM entries
         WHERE session_id = ? AND session_type = ?
         ORDER BY id ASC`,
      )
      .all(sessionId, sessionType) as Row[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      kind: r.kind as EntryKind,
      role: r.role,
      toolCallId: r.toolCallId,
      metadata:
        r.metadata !== null
          ? (JSON.parse(r.metadata) as Record<string, unknown>)
          : null,
    }));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

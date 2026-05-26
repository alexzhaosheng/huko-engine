/**
 * MemoryAgentPersistence — in-memory `AgentPersistence` for tests +
 * short-lived agents that don't need on-disk durability.
 *
 * Identical observable shape to `SqliteAgentPersistence`. The
 * conformance suite at packages/huko-engine/tests/agent-persistence.test.ts
 * runs the same battery against both implementations.
 *
 * No persistence across process restarts. `close()` is a no-op.
 */

import type {
  PersistFn,
  UpdateFn,
} from "../internal/SessionContext.js";
import type { LLMMessage } from "../llm/types.js";
import { isLLMVisible, type EntryKind, type SessionType } from "../shared/types.js";

import type {
  AgentPersistence,
  CreateSessionInput,
  CreateTaskInput,
  CreateTaskWithInitialEntryInput,
  UpdateTaskPatch,
} from "./agent-persistence.js";

type SessionRow = {
  id: number;
  title: string;
  kind: "chat" | "scheduled";
  scheduleId: string | null;
  createdAt: number;
  updatedAt: number;
};

type TaskRow = {
  id: number;
  chatSessionId: number | null;
  agentSessionId: number | null;
  status: string;
  modelId: string;
  toolCallMode: string;
  thinkLevel: string;
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

type EntryRow = {
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

export class MemoryAgentPersistence implements AgentPersistence {
  private readonly sessions = new Map<number, SessionRow>();
  private readonly tasks = new Map<number, TaskRow>();
  private readonly entries: EntryRow[] = [];
  private nextSessionId = 1;
  private nextTaskId = 1;
  private nextEntryId = 1;

  // ── Engine callbacks ─────────────────────────────────────────────────────

  readonly persist: PersistFn = async (entry) => {
    const id = this.nextEntryId++;
    this.entries.push({
      id,
      taskId: entry.taskId,
      sessionId: entry.sessionId,
      sessionType: entry.sessionType,
      kind: entry.kind,
      role: entry.role,
      content: entry.content,
      toolCallId: entry.toolCallId ?? null,
      thinking: entry.thinking ?? null,
      metadata: entry.metadata ?? null,
      createdAt: Date.now(),
    });
    return id;
  };

  readonly update: UpdateFn = async (entryId, patch) => {
    const row = this.entries.find((e) => e.id === entryId);
    if (!row) return;
    if (patch.content !== undefined) row.content = patch.content;
    if (patch.metadata !== undefined) {
      if (patch.mergeMetadata) {
        row.metadata = { ...(row.metadata ?? {}), ...patch.metadata };
      } else {
        row.metadata = patch.metadata;
      }
    }
  };

  // ── Replay ────────────────────────────────────────────────────────────────

  async loadInitialContext(
    sessionId: number,
    sessionType: SessionType,
  ): Promise<LLMMessage[]> {
    const messages: LLMMessage[] = [];
    for (const entry of this.entries) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.sessionType !== sessionType) continue;
      if (!isLLMVisible(entry.kind as EntryKind)) continue;
      messages.push(entryToMessage(entry));
    }
    messages.sort((_a, _b) => 0); // already in insertion order; entries are appended sequentially
    return messages;
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async createSession(input: CreateSessionInput): Promise<number> {
    const id = this.nextSessionId++;
    const now = Date.now();
    this.sessions.set(id, {
      id,
      title: input.title ?? "",
      kind: input.kind ?? "chat",
      scheduleId: input.scheduleId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  async createTask(input: CreateTaskInput): Promise<number> {
    const id = this.nextTaskId++;
    const now = Date.now();
    this.tasks.set(id, {
      id,
      chatSessionId: input.chatSessionId,
      agentSessionId: input.agentSessionId ?? null,
      status: input.status ?? "running",
      modelId: input.modelId,
      toolCallMode: input.toolCallMode,
      thinkLevel: input.thinkLevel,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      toolCallCount: 0,
      iterationCount: 0,
      finalResult: "",
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async createTaskWithInitialEntry(
    input: CreateTaskWithInitialEntryInput,
  ): Promise<{ taskId: number; entryId: number }> {
    const taskId = await this.createTask(input.task);
    const entryId = await this.persist({ ...input.entry, taskId });
    return { taskId, entryId };
  }

  async updateTask(id: number, patch: UpdateTaskPatch): Promise<void> {
    const row = this.tasks.get(id);
    if (!row) return;
    if (patch.status !== undefined) row.status = patch.status;
    if (patch.finalResult !== undefined) row.finalResult = patch.finalResult;
    if (patch.promptTokens !== undefined) row.promptTokens = patch.promptTokens;
    if (patch.completionTokens !== undefined) row.completionTokens = patch.completionTokens;
    if (patch.totalTokens !== undefined) row.totalTokens = patch.totalTokens;
    if (patch.toolCallCount !== undefined) row.toolCallCount = patch.toolCallCount;
    if (patch.iterationCount !== undefined) row.iterationCount = patch.iterationCount;
    if (patch.errorMessage !== undefined) row.errorMessage = patch.errorMessage;
    row.updatedAt = Date.now();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  close(): void {
    // No resources to release. Repeat calls are no-ops.
  }
}

function entryToMessage(entry: EntryRow): LLMMessage {
  if (entry.role === "tool") {
    return {
      role: "tool",
      content: entry.content,
      ...(entry.toolCallId !== null ? { tool_call_id: entry.toolCallId } : {}),
    };
  }
  return { role: entry.role, content: entry.content };
}

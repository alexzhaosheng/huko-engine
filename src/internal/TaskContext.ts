/**
 * server/engine/TaskContext.ts
 *
 * Task-scoped state container. One instance per task run.
 */

import type { Protocol, ThinkLevel, Tool, ToolCall, ToolCallMode } from "../llm/types.js";
import type { SessionOwnership, TaskStatus, UserAttachment } from "../shared/types.js";
import type { PlanState } from "../shared/plan-types.js";
import { BehaviorGuard } from "../task/behavior-guard.js";
import type { SessionContext } from "./SessionContext.js";
import type { RegisteredTool } from "../task/tools/registry.js";
import type { EngineConfig } from "../config/types.js";
import type { SafetyRulePersister } from "../safety/rule-persister.js";
import type { BestPracticesProvider } from "../task/tools/best-practices-provider.js";

/**
 * Per-task tool handler resolver. When set, the pipeline calls this
 * INSTEAD of the global `getTool(name)`. Used by the engine facade
 * (`createHukoEngine`) to scope tool registration to a `HukoEngine`
 * instance rather than process-wide.
 *
 * Pre-facade hosts (huko-cli today) don't set this — the pipeline
 * falls back to the global registry, preserving current behavior.
 */
export type ToolResolver = (name: string) => RegisteredTool | undefined;

/**
 * Per-task view of the host's engine instance — config, defaults, and
 * the four host-installed hooks. TaskContext carries one of these so
 * pipeline / tool code can reach for engine state without touching
 * the module-level globals (which only the engine constructor still
 * writes, for back-compat with tests + pre-facade callers).
 *
 * Structural interface (not a class import) to avoid a TaskContext →
 * facade → TaskContext circular dependency. The `HukoEngine` class
 * satisfies it by construction; tests that build a TaskContext
 * directly can supply a minimal stub.
 */
export interface EngineHandle {
  readonly config: EngineConfig;
  readonly defaultCwd: string;
  readonly safetyRulePersister: SafetyRulePersister | null;
  readonly bestPracticesProvider: BestPracticesProvider | null;
  resolveTool(name: string): RegisteredTool | undefined;
}

// ─── Callbacks ────────────────────────────────────────────────────────────────

export type WorkstationExecutor = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ result: string; error: string | null; screenshot?: string }>;

export type ApprovalCallback = (message: string) => Promise<boolean>;

export type WaitForReplyCallback = (payload: {
  toolCallId: string;
  question: string;
  options?: string[];
  selectionType?: "single" | "multiple";
}) => Promise<{ content: string; attachments?: UserAttachment[] }>;

/**
 * Frontend port for safety-policy decisions. Called by tool-execute
 * when `evaluatePolicy()` returns `{ action: "prompt" }`. The frontend
 * (CLI / daemon / IDE) shows the request to the operator and resolves
 * the promise with their choice.
 *
 * `-y` / non-interactive runs SHOULD NOT install this port — the
 * absence is the fail-closed signal (tool-execute treats `prompt` as
 * deny when the port is undefined).
 *
 * Outcomes:
 *   - `allow`               — execute this one call; rules unchanged
 *   - `deny`                — refuse this one call; rules unchanged
 *   - `allow_and_remember`  — execute, AND append the matched pattern
 *                             to `safety.toolRules.<tool>.allow` in the
 *                             global config so future calls auto-execute.
 *                             Only valid when `matchedPattern` is set.
 */
export type SafetyDecisionRequest = {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  reason: string;
  matchedPattern?: string;
  matchedField?: string;
  matchedValue?: string;
};

export type SafetyDecisionOutcome =
  | { kind: "allow" }
  | { kind: "deny" }
  | { kind: "allow_and_remember" };

export type RequestDecisionCallback = (
  req: SafetyDecisionRequest,
) => Promise<SafetyDecisionOutcome>;

// ─── TaskContext ──────────────────────────────────────────────────────────────

export type TaskContextOptions = SessionOwnership & {
  taskId: number;
  protocol: Protocol;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  contextWindow: number;
  headers?: Record<string, string>;
  extras?: Record<string, unknown>;
  tools: Tool[];
  systemPrompt: string;
  sessionContext: SessionContext;
  executeTool?: WorkstationExecutor;
  requestApproval?: ApprovalCallback;
  waitForReply?: WaitForReplyCallback;
  /** Safety-policy decision port. See SafetyDecisionRequest. */
  requestDecision?: RequestDecisionCallback;
  /** Where to persist "allow_and_remember" choices. */
  cwd?: string;
  externalAbortSignal?: AbortSignal;
  /**
   * Engine instance this task runs under. Pipeline + tools reach for
   * config / defaultCwd / safetyRulePersister / bestPracticesProvider
   * / resolveTool through this handle rather than module globals.
   *
   * Required for new code. The legacy `toolResolver` callback below
   * remains for transitional callers that build a TaskContext without
   * an engine (engine-demo script, a couple of low-level tests).
   */
  engine?: EngineHandle;
  /**
   * @deprecated — superseded by `engine.resolveTool`. Pipeline still
   * honours it when present so transitional construction sites can
   * keep working. New code passes `engine` and skips this field.
   */
  toolResolver?: ToolResolver;
};

/**
 * Engine kernel primitive — per-task runtime state and injected host
 * capability (provider config, tools, sessionContext, decision hooks).
 *
 * @internal — new hosts use the public facade (`createHukoEngine`,
 * `HukoAgent`); TaskContext stays exported via subpath for engine tests
 * and pre-facade hand-wired paths. Direct construction skips the
 * lifecycle bookkeeping the facade does for you (overlays, registries,
 * subscriber fan-out, task-row write-back).
 */
export class TaskContext {
  readonly taskId: number;
  readonly sessionType: "chat" | "agent";
  readonly chatSessionId?: number;
  readonly agentSessionId?: number;

  readonly protocol: Protocol;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly toolCallMode: ToolCallMode;
  readonly thinkLevel: ThinkLevel;
  readonly contextWindow: number;
  readonly headers?: Record<string, string>;
  readonly extras?: Record<string, unknown>;

  tools: Tool[];
  systemPrompt: string;

  readonly sessionContext: SessionContext;

  readonly executeTool?: WorkstationExecutor;
  readonly requestApproval?: ApprovalCallback;
  readonly waitForReply?: WaitForReplyCallback;
  readonly requestDecision?: RequestDecisionCallback;
  readonly cwd?: string;
  readonly toolResolver?: ToolResolver;
  readonly engine?: EngineHandle;

  readonly masterAbort: AbortController;
  currentLlmAbort: AbortController | null = null;
  currentToolPromise: Promise<unknown> | null = null;

  toolCallCount: number = 0;
  promptTokens: number = 0;
  completionTokens: number = 0;
  totalTokens: number = 0;
  /** Subset of promptTokens billed as cache reads (provider-reported). */
  cachedTokens: number = 0;
  /** Subset written into the prompt cache during this task (Anthropic). */
  cacheCreationTokens: number = 0;
  iterationCount: number = 0;

  deferredCalls: ToolCall[] = [];

  finalResult: string = "";
  hasExplicitResult: boolean = false;
  taskFailed: boolean = false;
  taskStopped: boolean = false;

  interjected: boolean = false;

  planState: PlanState | null = null;
  readonly behavior: BehaviorGuard = new BehaviorGuard();
  workingLanguage: string | null = null;

  readonly startTime: number = Date.now();

  constructor(opts: TaskContextOptions) {
    this.taskId = opts.taskId;
    this.sessionType = opts.sessionType;

    if (opts.sessionType === "chat") {
      this.chatSessionId = opts.chatSessionId;
    } else {
      this.agentSessionId = opts.agentSessionId;
    }

    this.protocol = opts.protocol;
    this.modelId = opts.modelId;
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.toolCallMode = opts.toolCallMode;
    this.thinkLevel = opts.thinkLevel;
    this.contextWindow = opts.contextWindow;
    if (opts.headers !== undefined) this.headers = opts.headers;
    if (opts.extras !== undefined) this.extras = opts.extras;

    this.tools = opts.tools;
    this.systemPrompt = opts.systemPrompt;
    this.sessionContext = opts.sessionContext;

    if (opts.executeTool !== undefined) this.executeTool = opts.executeTool;
    if (opts.requestApproval !== undefined) this.requestApproval = opts.requestApproval;
    if (opts.waitForReply !== undefined) this.waitForReply = opts.waitForReply;
    if (opts.requestDecision !== undefined) this.requestDecision = opts.requestDecision;
    if (opts.cwd !== undefined) this.cwd = opts.cwd;
    if (opts.toolResolver !== undefined) this.toolResolver = opts.toolResolver;
    if (opts.engine !== undefined) this.engine = opts.engine;

    this.masterAbort = new AbortController();
    if (opts.externalAbortSignal) {
      if (opts.externalAbortSignal.aborted) {
        this.masterAbort.abort();
      } else {
        opts.externalAbortSignal.addEventListener(
          "abort",
          () => this.masterAbort.abort(),
          { once: true },
        );
      }
    }
  }

  get sessionId(): number {
    return (this.chatSessionId ?? this.agentSessionId)!;
  }

  get elapsedMs(): number {
    return Date.now() - this.startTime;
  }

  get isAborted(): boolean {
    return this.masterAbort.signal.aborted;
  }

  addTokens(usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
    if (usage.cachedTokens) this.cachedTokens += usage.cachedTokens;
    if (usage.cacheCreationTokens) this.cacheCreationTokens += usage.cacheCreationTokens;
  }

  summary(): {
    toolCallCount: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    iterationCount: number;
    elapsedMs: number;
  } {
    return {
      toolCallCount: this.toolCallCount,
      totalTokens: this.totalTokens,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cachedTokens: this.cachedTokens,
      cacheCreationTokens: this.cacheCreationTokens,
      iterationCount: this.iterationCount,
      elapsedMs: this.elapsedMs,
    };
  }

  resolveStatus(): TaskStatus {
    if (this.taskStopped) return "stopped";
    if (this.taskFailed) return "failed";
    return "done";
  }

  /**
   * Reset the interjection flag. The task loop calls this once per
   * iteration before invoking the LLM so a previously-set interjection
   * doesn't linger. The flag is set externally by
   * `TaskLoop.interject()` and observed by other parts of the loop
   * (e.g. compaction); there is currently no consumer that needs the
   * previous value at this point.
   */
  clearInterjectionFlag(): void {
    this.interjected = false;
  }
}

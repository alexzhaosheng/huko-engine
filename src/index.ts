/**
 * @alexzhaosheng/huko-engine — public barrel
 *
 * The recommended entry for new hosts:
 *
 *   import {
 *     createHukoEngine,
 *     SqliteAgentPersistence,
 *     MemoryAgentPersistence,
 *   } from "@alexzhaosheng/huko-engine";
 *
 * Plus the types they'll touch: `Provider`, `PromptOverlay`,
 * `StartTurnInput`, `TaskHandle`, `AgentTurnResult`, `HukoEvent`,
 * `EngineToolRegistration`.
 *
 * Kernel primitives (`TaskLoop`, `TaskContext`, `SessionContext`,
 * `assembleSystemPrompt`, `assembleLeanSystemPrompt`, `recoverOrphans`)
 * live under `src/internal/`. They're reachable via subpath import
 * in workspace mode for cli + tests; the published `exports` map
 * (see `publishConfig.exports` in package.json) DROPS `internal/*`
 * so external npm consumers cannot bypass the facade. New host code
 * uses the barrel.
 */

export const ENGINE_PACKAGE_NAME = "@alexzhaosheng/huko-engine";

// ─── Facade ─────────────────────────────────────────────────────────────────

export {
  createHukoEngine,
  createHukoEngineSync,
  HukoEngine,
  HukoAgent,
  type HukoEngineOptions,
  type HukoEngineHostHooks,
  type HukoAgentOptions,
  type EngineToolRegistration,
  type Provider,
  type StartTurnInput,
  type TaskHandle,
  type AgentTurnResult,
  type PendingAsk,
  type PendingDecision,
  type OrphanRecord,
  type RecoveryReport,
} from "./facade.js";

/**
 * Resolved value of `TaskHandle.completion`. Exposed here so hosts
 * awaiting a startTurn handle don't have to reach into the @internal
 * `task/task-loop.js` subpath for the result type.
 */
export type { TaskRunSummary } from "./internal/task-loop.js";

// ─── Persistence ────────────────────────────────────────────────────────────

export {
  SqliteAgentPersistence,
  MemoryAgentPersistence,
  type AgentPersistence,
  type CreateSessionInput,
  type CreateTaskInput,
  type UpdateTaskPatch,
} from "./persistence/index.js";

// ─── Prompt ────────────────────────────────────────────────────────────────

export type {
  PromptOverlay,
  OverlayPosition,
} from "./prompt/overlay.js";

// ─── Events + protocol types host code needs ────────────────────────────────

export type { HukoEvent } from "./shared/events.js";
export type {
  Protocol,
  ThinkLevel,
  ToolCallMode,
  LLMMessage,
} from "./llm/types.js";

/**
 * Daemon-style hosts (transports that fan kernel events out to
 * per-session WebSocket rooms) reach for this to construct the
 * emitter their `TaskOrchestrator.emitterFactory` returns. The
 * SessionContext subpath that originally exposed it is internal —
 * the type itself is small and stable, so it lives on the facade
 * barrel.
 */
export type { Emitter } from "./internal/SessionContext.js";

// ─── Built-in best practices (convenience for hostHooks.bestPracticesProvider) ─

/**
 * Engine-bundled best-practices for the four foundational
 * capabilities (coding / writing / research / analysis). Mirrors the
 * SqliteAgentPersistence pattern: a ready-to-use convenience that
 * hosts install via `hostHooks.bestPracticesProvider` when they don't
 * have their own checklist registry.
 */
export {
  BUILT_IN_BEST_PRACTICES,
  DEFAULT_MAX_BODY_CHARS,
  extractBestPracticesSection,
  resolveBestPracticeBody,
  resolveBuiltInBestPractice,
  formatBestPracticesInjection,
  defaultBestPracticesProvider,
} from "./task/tools/best-practices-built-in.js";

export type { BestPracticesProvider } from "./task/tools/best-practices-provider.js";

// ─── Foundational tools (per-instance registration) ─────────────────────────

/**
 * The 13 engine-shipped tools (bash, glob, grep, plan, message, ...)
 * as an array of `EngineToolRegistration` objects + a
 * `registerFoundationalTools(engine)` convenience that loops them
 * onto an engine instance. Mirrors `defaultBestPracticesProvider` —
 * one line of host wiring for the bundled defaults.
 */
export {
  FOUNDATIONAL_TOOL_REGISTRATIONS,
  registerFoundationalTools,
} from "./task/tools/foundational.js";

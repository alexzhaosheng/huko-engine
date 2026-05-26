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
 * Everything host code touches lives on this barrel — types, runtime
 * facade, persistence implementations, tool-registry helpers, safety
 * policy primitives, feature framework, skill parsing, prompt
 * overlays, debug log wiring, config state, language-reminder
 * helpers. Hosts MUST NOT reach into engine subpaths — the published
 * `exports` map (see package.json) does not enumerate them. The
 * facade is the boundary.
 *
 * Kernel primitives (`TaskLoop`, `TaskContext`, `SessionContext`,
 * `assembleSystemPrompt`, `assembleLeanSystemPrompt`, `recoverOrphans`)
 * live under `src/internal/`. They're not on this barrel and not in
 * the exports map — external consumers can't import them. Engine's
 * own tests reach them via relative paths.
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

export type { TaskRunSummary } from "./internal/task-loop.js";

/**
 * Manual orphan-recovery trigger. `createHukoEngine` calls this for
 * you during construction, so hosts that use the facade don't have to
 * touch it. Exposed at the barrel for tests + advanced hosts that
 * manage persistence outside the engine and want recovery on demand.
 */
export { recoverOrphans } from "./internal/resume.js";

/**
 * Daemon-style hosts (transports that fan kernel events out to
 * per-session WebSocket rooms) reach for this to construct the
 * emitter their `TaskOrchestrator.emitterFactory` returns. The
 * SessionContext subpath that originally exposed it is internal —
 * the type itself is small and stable, so it lives on the facade
 * barrel.
 */
export type { Emitter } from "./internal/SessionContext.js";

/**
 * The execution context passed to every tool handler. Host tool
 * authors (cli's browser/share_file, app-studio's write_definition_file)
 * receive a `TaskContext` argument and read structured fields off it
 * (working directory, session id, emit helpers, policy state, …).
 *
 * The class itself stays under `src/internal/` — its constructor +
 * private state are engine kernel. The TYPE shape is public.
 */
export type { TaskContext } from "./internal/TaskContext.js";

// ─── Persistence ────────────────────────────────────────────────────────────

export {
  SqliteAgentPersistence,
  MemoryAgentPersistence,
  type AgentPersistence,
  type CreateSessionInput,
  type CreateTaskInput,
  type UpdateTaskPatch,
} from "./persistence/index.js";

export type {
  PersistFn,
  UpdateFn,
  CreateTaskWithInitialEntryInput,
  InitialEntryInput,
  RecoverableEntryRow,
  RecoverableTaskRow,
} from "./persistence/agent-persistence.js";

export type {
  SessionPersistence,
  SubstitutionRecord,
  SubstitutionRow,
  ChatSessionRow,
  CreateChatSessionInput,
  EntryRow,
  TaskRow,
} from "./persistence/types.js";

// ─── Prompt ─────────────────────────────────────────────────────────────────

export type {
  PromptOverlay,
  OverlayPosition,
} from "./prompt/overlay.js";

// ─── Events ─────────────────────────────────────────────────────────────────

export {
  HUKO_WIRE_EVENT,
} from "./shared/events.js";

export type {
  HukoEvent,
  AskUserEvent,
  DecisionRequiredEvent,
  FileSharedEvent,
  TaskSummary,
} from "./shared/events.js";

// ─── LLM protocol types ─────────────────────────────────────────────────────

export type {
  Protocol,
  ThinkLevel,
  ToolCallMode,
  LLMMessage,
  ToolCall,
} from "./llm/types.js";

// ─── LLM utilities ──────────────────────────────────────────────────────────

export { invoke } from "./llm/invoke.js";

export { estimateContextWindow } from "./llm/model-context-window.js";

export { setRawDebugLogWorkingDirectory } from "./llm/raw-debug-log.js";

// ─── Shared types ───────────────────────────────────────────────────────────

export {
  EntryKind,
  isLLMVisible,
} from "./shared/types.js";

export type {
  SessionType,
  TaskStatus,
  UserAttachment,
} from "./shared/types.js";

// ─── Config ─────────────────────────────────────────────────────────────────

export type {
  EngineConfig,
  CompactionLevel,
} from "./config/types.js";

export {
  COMPACTION_LEVELS,
  COMPACTION_LEVEL_TARGETS,
  DEFAULT_ENGINE_CONFIG,
} from "./config/types.js";

export {
  deriveTargetFromThreshold,
  ratioForLevel,
  resolveCompaction,
} from "./config/compaction.js";

export type { ResolvedCompaction } from "./config/compaction.js";

export {
  getEngineConfig,
  setEngineConfig,
  _resetEngineConfigForTests,
} from "./config/state.js";

// ─── Safety ─────────────────────────────────────────────────────────────────

export {
  MATCH_FIELDS,
  evaluatePolicy,
  matchPattern,
  validateRules,
  extractMatchableValues,
} from "./safety/policy.js";

export type {
  PolicyDecision,
  RuleValidationIssue,
} from "./safety/policy.js";

export type {
  SafetyAction,
  SafetyPolicy,
  ToolSafetyRules,
} from "./safety/types.js";

export type { EvaluatePolicyInput } from "./safety/policy.js";

// ─── Skills ─────────────────────────────────────────────────────────────────

export { activeSkillNames } from "./skills/active.js";

export {
  parseFrontmatter,
  splitFrontmatter,
} from "./skills/parse.js";

export type {
  Skill,
  SkillFrontmatter,
  SkillSource,
} from "./skills/types.js";

// ─── Features ───────────────────────────────────────────────────────────────

export {
  assertNoNameCollisionsWithTools,
  computeEnabledFeatures,
  getFeature,
  listFeatures,
  registerFeature,
  _resetFeatureRegistryForTests,
} from "./features/registry.js";

export type {
  Feature,
  FeaturesConfig,
  Sidecar,
  SidecarDeps,
} from "./features/registry.js";

export {
  startEnabledSidecars,
  stopAllSidecars,
  _resetSidecarsForTests,
} from "./features/sidecars.js";

export type { StartResult } from "./features/sidecars.js";

export { initFeatureRuntime } from "./features/runtime.js";

export type {
  InitFeatureRuntimeOptions,
  InitFeatureRuntimeResult,
} from "./features/runtime.js";

// ─── Task / language ────────────────────────────────────────────────────────

export {
  detectWorkingLanguage,
  classifyWorkingLanguage,
  countCjk,
  countLatin,
  maybeBuildLanguageDriftReminder,
} from "./task/language-reminder.js";

// ─── Tool registry (global) ─────────────────────────────────────────────────

export {
  coerceArgs,
  getTool,
  getToolPolicy,
  getToolPromptHints,
  getToolsForLLM,
  isLegacyServerToolResult,
  isToolHandlerResult,
  isWorkstationTool,
  isWritableTool,
  listToolNames,
  registerServerTool,
  registerWorkstationTool,
  setEnabledFeatures,
  setToolPolicy,
  _resetRegistryForTests,
} from "./task/tools/registry.js";

export type {
  PostReminder,
  ServerToolDefinition,
  ServerToolHandler,
  ServerToolResult,
  ToolAttachment,
  ToolDangerLevel,
  ToolFilter,
  ToolFilterContext,
  ToolHandlerResult,
  ToolPolicyMeta,
  WorkstationToolDefinition,
} from "./task/tools/registry.js";

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
  registerFoundationalToolsGlobally,
} from "./task/tools/foundational.js";

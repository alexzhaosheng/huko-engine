/**
 * createHukoEngine / HukoEngine / HukoAgent — the public facade.
 *
 * Hosts describe agent CONCEPTS (persistence, tools, overlays, provider)
 * and the facade owns the runtime contract — replaces the pattern where
 * hosts hand-wire `TaskLoop` + `TaskContext` + `SessionContext`
 * themselves (which inevitably loses agent behaviour — see
 * `docs/public-api-facade.md`).
 *
 * Surface (in scope today):
 *   - `createHukoEngine`
 *   - `HukoEngine` — per-instance tool registry, persistence, host-hook
 *     integration (config / defaultCwd / safety / best-practices), and
 *     a `createSession` convenience.
 *   - `HukoAgent` — session-pinned (one chat_session per agent). Owns
 *     its `SessionContext` cache, the current live task, the ask /
 *     decision registries, and the event subscribers. Two entry points:
 *       - `runTurn(input)` returns `AgentTurnResult` (the await-the-end
 *         shape — one HTTP request → one turn → one JSON response)
 *       - `startTurn(input)` returns `TaskHandle` (the fire-and-track
 *         shape daemon orchestrators use)
 *
 * What's still deferred:
 *   - `resumeTask` (orphan-recovery surface — cli does it host-side via
 *     persistence.tasks.listNonTerminal today)
 *   - moving the engine module-level globals (engine config, default
 *     cwd, safety persister, best-practices) onto the HukoEngine
 *     instance — they're 48 callsites across 19 engine files; for now
 *     the engine constructor *installs* host-provided values into the
 *     globals so `install-engine-host-hooks.ts` can be deleted, and a
 *     future round threads engine context through TaskContext.
 */

import { SessionContext } from "./internal/SessionContext.js";
import { TaskContext, type EngineHandle } from "./internal/TaskContext.js";
import { TaskLoop, type TaskRunSummary } from "./internal/task-loop.js";
import { assembleSystemPrompt } from "./internal/prompt/assemble.js";
import { assembleLeanSystemPrompt } from "./internal/prompt/lean.js";
import type { PromptOverlay } from "./prompt/overlay.js";
import type {
  Protocol,
  ThinkLevel,
  Tool,
  ToolCallMode,
} from "./llm/types.js";
import type {
  RequestDecisionCallback,
} from "./internal/TaskContext.js";
import type {
  AskUserEvent,
  DecisionRequiredEvent,
  HukoEvent,
} from "./shared/events.js";
import {
  EntryKind,
  type SessionType,
  type TaskStatus,
  type UserAttachment,
} from "./shared/types.js";
import type { Skill } from "./skills/types.js";
import type { ScheduledTaskInput } from "./prompt/blocks.js";
import {
  getTool as getGlobalTool,
  listToolNames as listGlobalToolNames,
  materializeToolPromptHints,
  materializeToolsForLLM,
  type RegisteredTool,
  type ServerToolDefinition,
  type ServerToolHandler,
  type ToolFilterContext,
} from "./task/tools/registry.js";

import type {
  AgentPersistence,
  CreateSessionInput,
} from "./persistence/agent-persistence.js";
import {
  recoverOrphans,
  type OrphanRecord,
  type RecoveryReport,
} from "./internal/resume.js";

import {
  setEngineConfig,
  setEngineDefaultCwd,
} from "./config/state.js";
import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "./config/types.js";
import {
  setSafetyRulePersister,
  type SafetyRulePersister,
} from "./safety/rule-persister.js";
import {
  setBestPracticesProvider,
  type BestPracticesProvider,
} from "./task/tools/best-practices-provider.js";
import { defaultBestPracticesProvider } from "./task/tools/best-practices-built-in.js";
import { registerFoundationalTools } from "./task/tools/foundational.js";

// ─── Provider ───────────────────────────────────────────────────────────────

/**
 * LLM endpoint + model config. Engine takes Provider objects as data;
 * the host constructs them however its config layer wants. Engine does
 * NOT resolve API key refs / read keys.json / talk to a vault.
 */
export type Provider = {
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  contextWindow: number;
  headers?: Record<string, string>;
};

// ─── Engine options ─────────────────────────────────────────────────────────

/**
 * Host-side integration hooks the engine consults for cross-cutting
 * concerns. Today these install into engine module-level state
 * (effectively making the LAST constructed engine the "active" host
 * integration — fine for single-engine processes, which is every
 * current huko host). A future round will thread them through
 * TaskContext so multiple engines can coexist with different hooks.
 */
export type HukoEngineHostHooks = {
  /** Engine-eligible config slice (safety, llm timeouts, etc). */
  config?: EngineConfig;
  /**
   * Working-directory fallback engine tools (bash/glob/grep/...) use
   * when neither call args nor TaskContext.cwd supplies one. Engine
   * code never reads `process.cwd()` itself.
   */
  defaultCwd?: string;
  /**
   * Callback the safety policy invokes when the operator chooses
   * "always allow" on a tool decision — typically writes back to the
   * host's config files. Pass `null` to clear an installed one.
   */
  safetyRulePersister?: SafetyRulePersister | null;
  /**
   * Callback the plan tool invokes to inject role-flavoured
   * best-practices into a `plan(update)` tool_result.
   *
   * Behaviour by value:
   *   - `undefined` (omitted) — engine uses `defaultBestPracticesProvider`
   *     out of the box: the four bundled capabilities (`coding`,
   *     `writing`, `research`, `analysis`) automatically inject
   *     when a plan phase tags them. No wiring required.
   *   - explicit function — engine uses your provider. Wrap
   *     `defaultBestPracticesProvider` if you want filesystem
   *     overrides on top of the bundled defaults.
   *   - explicit `null` — engine injects nothing. Use this to
   *     opt out of best-practices entirely.
   */
  bestPracticesProvider?: BestPracticesProvider | null;
};

export type HukoEngineOptions = {
  /** Default persistence for agents that don't specify their own. */
  persistence: AgentPersistence;
  /** Host integration hooks; see HukoEngineHostHooks. */
  hostHooks?: HukoEngineHostHooks;
  /**
   * Register the 13 foundational tools (bash, glob, grep, list-dir,
   * read-file, write-file, edit-file, delete-file, move-file, plan,
   * message, web-fetch, web-search) on this engine instance.
   *
   *   - `true` (default) — engine calls `registerFoundationalTools(this)`
   *     during construction. Tools become resolvable by name; they
   *     ONLY land in an agent's LLM surface when the agent's
   *     `tools.allow` lists them, so this default is safe by default.
   *   - `false` — skip registration. Use this when the host wants
   *     to substitute its own implementation of a foundational
   *     tool (e.g. a sandboxed `bash`) and register a subset
   *     manually.
   *
   * Registering twice (auto + then manual `registerFoundationalTools`)
   * throws on duplicate names; if you want a custom set, opt out and
   * pick what you register.
   */
  foundationalTools?: boolean;
  /**
   * Optional per-record callback fired during the engine's automatic
   * orphan-recovery scan at construction time. Hosts use it for
   * visibility — e.g. cli emits an `orphan_recovered` HukoEvent per
   * record and the text formatter renders a yellow warning.
   *
   * Recovery itself is fully automatic; this callback ONLY surfaces
   * what was found. Embedding hosts (in-memory tests, short-lived
   * processes) typically omit it. Persistence implementations that don't
   * implement `listNonTerminalTasks` skip the scan entirely and the
   * callback never fires.
   *
   * Callback failures are swallowed — recovery is best-effort
   * observability, not a critical path.
   */
  onOrphanRecovered?: (record: OrphanRecord) => void;
};

// ─── Tool registration ──────────────────────────────────────────────────────

/**
 * Engine's per-instance tool definition. Same shape as
 * `ServerToolDefinition` + handler, plus an optional `promptHint` that
 * the facade renders alongside the tool description when the tool is
 * part of an agent's surface. The host can't accidentally desync
 * description + hint — they're attached to the same record.
 */
export type EngineToolRegistration = ServerToolDefinition & {
  handler: ServerToolHandler;
  promptHint?: string;
};

// ─── Agent options ──────────────────────────────────────────────────────────

export type HukoAgentOptions = {
  /** Stable name for debugging + future caching. */
  name: string;
  /**
   * The chat (or scheduled) session this agent is pinned to. Agent
   * caches a `SessionContext` for the session lifetime so successive
   * turns share llmContext without re-replaying from persistence.
   * Hosts that need a fresh session call `engine.createSession()`
   * first and pass the returned id here.
   */
  sessionId: number;
  /** Defaults to "chat". Use "agent" for nested sub-agents (future). */
  sessionType?: SessionType;
  /** Base prompt template. "lean" swaps in `assembleLeanSystemPrompt`. */
  profile?: "full" | "lean";
  /** Working directory for engine tools. Per-agent, not per-turn. */
  cwd?: string;
  /** Overrides the engine default persistence. */
  persistence?: AgentPersistence;
  /** Default model for this agent. Per-turn overrides supersede. */
  defaultProvider?: Provider;
  /**
   * If false, `<tool_use>` won't render `message(ask)` and tool calls
   * gated by the safety policy will fail-closed (`deny`) instead of
   * prompting. Defaults to true.
   */
  interactive?: boolean;
  /**
   * Tool filter — allow-list (whitelist) of tool names; only these are
   * rendered to the LLM and dispatchable. Defaults to no tools.
   */
  tools?: { allow?: readonly string[] };
  /** Host-supplied prompt overlays (static for this agent's lifetime). */
  overlays?: readonly PromptOverlay[];
  /** Already-loaded operator skills. */
  skills?: readonly Skill[];
  /** Project-context blob; engine renders it as a single block. */
  projectContext?: string | null;
  /** Wall-clock injected into the cache-tail current-date line. */
  currentDate?: Date;
  /** Working-language pin; null lets the LLM choose. */
  workingLanguage?: string | null;
  /** Platform rendered in `<local>` (process.platform on Node). */
  platform?: string;
  /** Cron framing for scheduled-task agents (static if always-scheduled). */
  scheduledTask?: ScheduledTaskInput;
  /**
   * Optional outbound text-scrubber. The session-pinned SessionContext
   * runs every persisted entry's content through this before storage +
   * llmContext write. Returns the redacted form; implementations also
   * record the (placeholder → raw) substitution in their own table.
   * Pairs with `expandArgs` for the inverse on tool args.
   *
   * cli wires `scrubAndRecord` from its security/scrubber.ts here.
   * Embedding hosts that don't need scrubbing can leave it unset.
   */
  scrubText?: (text: string) => Promise<string>;
  /**
   * Optional inverse of `scrubText` — recursively expand any
   * `[REDACTED:<name>]` placeholders inside JSON-shaped tool args
   * back to raw values before the handler runs. cli wires
   * `expandPlaceholdersDeep` here.
   */
  expandArgs?: (value: unknown) => Promise<unknown>;
};

// ─── Per-turn input + result ────────────────────────────────────────────────

export type StartTurnInput = {
  /** The user message text for this turn. */
  message: string;
  /** File/image attachments captured in user-message metadata. */
  attachments?: readonly UserAttachment[];
  /** Per-turn provider override; falls back to agent.defaultProvider. */
  provider?: Provider;
  /**
   * Override `profile === "lean"` for this turn. When true (and the
   * agent's tools.allow is unset) the tool surface narrows to `bash`.
   */
  lean?: boolean;
  /** Per-turn interactivity override (scheduled fires force false). */
  interactive?: boolean;
  /** Per-turn scheduled-task framing (cron fires set this). */
  scheduledTask?: ScheduledTaskInput;
  /** Extra overlays merged onto agent.overlays for this turn only. */
  extraOverlays?: readonly PromptOverlay[];
  /** Per-turn tool-filter override (e.g. setup mode swapping toolset). */
  toolsAllow?: readonly string[];
  /**
   * Pre-materialized LLM-visible tool list. When set, the facade uses
   * it directly instead of running its own materialization off the
   * allow-list. Hosts that need per-tool dynamic descriptions
   * (platform notes, lean materialization, interactive-mode parameter
   * shaping — huko-cli does all three via `getToolsForLLM(filter)`)
   * compute this themselves and pass it through. Pair with
   * `toolPromptHints` so the hint list stays aligned with the tools
   * the LLM actually sees.
   */
  toolsMaterialized?: readonly Tool[];
  /** Pre-materialized prompt hints; pairs with `toolsMaterialized`. */
  toolPromptHints?: readonly string[];
  /** Per-turn skills override; falls back to agent.skills. */
  skills?: readonly Skill[];
  /** Per-turn project context override; falls back to agent.projectContext. */
  projectContext?: string | null;
  /** Per-turn working-language override. */
  workingLanguage?: string | null;
  /**
   * Per-turn working-directory override. Engine tools (bash/glob/...)
   * see this in TaskContext.cwd; the prompt's `<local>` block renders
   * it too. Falls back to agent.cwd when omitted.
   */
  cwd?: string;
  /**
   * If true and a live task exists for this agent, abort any pending
   * `message(ask)` on it, append the user message into the live task,
   * and interject. If no live task exists, behaves as a normal new
   * task. Defaults to false (live task throws an error if you didn't
   * opt in).
   */
  interject?: boolean;
};

/**
 * Handle returned by `startTurn`. The host awaits `completion` when it
 * wants the final summary, and can read `taskId` immediately for
 * tracking / event correlation.
 */
export type TaskHandle = {
  taskId: number;
  /** True when this call attached to an in-flight task, not started new. */
  interjected: boolean;
  /** Resolves with the task's final TaskRunSummary. */
  completion: Promise<TaskRunSummary>;
};

/**
 * High-level `runTurn` result — startTurn + await + collected events.
 * Kept for embedding hosts that want a one-shot batch result without
 * subscribing to streaming events (e.g. a synchronous HTTP handler).
 */
export type AgentTurnResult = {
  sessionId: number;
  taskId: number;
  status: TaskStatus;
  finalResult: string;
  errorMessage: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCallCount: number;
  iterationCount: number;
  events: readonly HukoEvent[];
};

// ─── Registry snapshot types ────────────────────────────────────────────────

export type PendingAsk = {
  toolCallId: string;
  taskId: number;
  question: string;
  options?: string[];
  selectionType?: "single" | "multiple";
  ts: number;
};

export type PendingDecision = {
  toolCallId: string;
  taskId: number;
};

// ─── Internal resolver shapes ───────────────────────────────────────────────

type AskResolver = {
  taskId: number;
  question: string;
  options?: string[];
  selectionType?: "single" | "multiple";
  ts: number;
  resolve: (reply: {
    content: string;
    attachments?: UserAttachment[];
  }) => void;
  reject: (err: Error) => void;
};

type DecisionResolver = {
  taskId: number;
  resolve: (outcome: {
    kind: "allow" | "deny" | "allow_and_remember";
  }) => void;
  reject: (err: Error) => void;
};

// ─── HukoEngine ─────────────────────────────────────────────────────────────

export class HukoEngine implements EngineHandle {
  private readonly tools = new Map<string, RegisteredTool>();
  private closed = false;

  // ── EngineHandle surface (per-instance, no globals) ──────────────────────
  readonly config: EngineConfig;
  readonly defaultCwd: string;
  readonly safetyRulePersister: SafetyRulePersister | null;
  readonly bestPracticesProvider: BestPracticesProvider | null;

  /**
   * Per-engine feature gating. Tools tagged `feature: "X"` are
   * filtered out of this engine's tool surface unless "X" is in this
   * set. Independent of the legacy process-global enabledFeatures —
   * two engines can have disjoint feature sets in the same process.
   *
   * Populated via `setEnabledFeatures`; consumed by
   * `getToolsForLLM` / `getToolPromptHints` below.
   */
  private readonly _enabledFeatures = new Set<string>();

  constructor(readonly options: HukoEngineOptions) {
    // Per-instance state — pipeline / tools reach for these through
    // ctx.engine, NOT through module-level globals.
    this.config = options.hostHooks?.config ?? DEFAULT_ENGINE_CONFIG;
    this.defaultCwd = options.hostHooks?.defaultCwd ?? ".";
    this.safetyRulePersister = options.hostHooks?.safetyRulePersister ?? null;
    // bestPracticesProvider: distinguish "not supplied" from explicit
    // opt-out. `undefined` → default (built-in 4 capabilities); `null`
    // → no injection at all; explicit function → use that.
    this.bestPracticesProvider =
      options.hostHooks?.bestPracticesProvider === undefined
        ? defaultBestPracticesProvider
        : options.hostHooks.bestPracticesProvider;

    // Module-level globals: installed for back-compat with transitional
    // callers (engine-demo script, a couple of low-level tests that
    // construct a TaskContext without supplying an engine handle).
    // Production code paths now read off `ctx.engine.*` and ignore
    // these. The globals will go away once those callsites migrate.
    this.installHostHooks(options.hostHooks);
  }

  private installHostHooks(hooks: HukoEngineHostHooks | undefined): void {
    if (!hooks) return;
    if (hooks.config !== undefined) setEngineConfig(hooks.config);
    if (hooks.defaultCwd !== undefined) setEngineDefaultCwd(hooks.defaultCwd);
    if (hooks.safetyRulePersister !== undefined) {
      setSafetyRulePersister(hooks.safetyRulePersister);
    }
    if (hooks.bestPracticesProvider !== undefined) {
      setBestPracticesProvider(hooks.bestPracticesProvider);
    }
  }

  registerTool(reg: EngineToolRegistration): void {
    if (this.closed) throw new Error("HukoEngine is closed");
    if (this.tools.has(reg.name)) {
      throw new Error(
        `Tool "${reg.name}" is already registered on this engine`,
      );
    }
    const { handler, ...definition } = reg;
    this.tools.set(reg.name, {
      kind: "server",
      definition,
      handler,
    });
  }

  listTools(filter?: { allow?: readonly string[] }): ServerToolDefinition[] {
    const allow = filter?.allow ? new Set(filter.allow) : null;
    const out: ServerToolDefinition[] = [];
    for (const [name, registered] of this.tools) {
      if (allow !== null && !allow.has(name)) continue;
      if (registered.kind === "server") out.push(registered.definition);
    }
    return out;
  }

  /** Convenience wrapper around `persistence.createSession`. */
  async createSession(input: CreateSessionInput = {}): Promise<number> {
    return this.options.persistence.createSession(input);
  }

  createAgent(options: HukoAgentOptions): HukoAgent {
    if (this.closed) throw new Error("HukoEngine is closed");
    return new HukoAgent(this, options);
  }

  /**
   * Internal: tool resolver passed into TaskContext. Per-instance
   * tools win; falls back to the global registry so hosts that still
   * register tools via side-effect imports (huko-cli today) keep
   * working without re-registering every tool on the engine.
   */
  resolveTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name) ?? getGlobalTool(name);
  }

  /** Internal: materialize an LLM-visible Tool list from the filter. */
  materializeTools(allow: ReadonlySet<string>): Tool[] {
    const out: Tool[] = [];
    for (const name of allow) {
      const registered = this.resolveTool(name);
      if (!registered || registered.kind !== "server") continue;
      const def = registered.definition;
      out.push({
        name: def.name,
        description: def.description,
        parameters: def.parameters,
      });
    }
    return out;
  }

  /** Internal: collect prompt hints from the same filter. */
  materializePromptHints(allow: ReadonlySet<string>): string[] {
    const out: string[] = [];
    for (const name of allow) {
      const registered = this.resolveTool(name);
      if (!registered || registered.kind !== "server") continue;
      const hint = registered.definition.promptHint;
      if (hint && hint.trim()) out.push(hint.trim());
    }
    return out;
  }

  /**
   * Public: materialize the full LLM-visible tool list under a
   * `getToolsForLLM`-style filter (allow/deny, interactive, lean,
   * safety-disabled, feature-gated). Walks engine-instance tools
   * merged with the process-global registry; engine wins on conflict.
   *
   * Per-engine gating: this method uses `this._enabledFeatures` (set
   * via `setEnabledFeatures`) and `this.config.safety` (set via
   * `hostHooks.config`), NOT the process-global state. Two engines
   * with different feature sets / safety configs produce independent
   * tool surfaces from the same merged tool view.
   */
  getToolsForLLM(filter?: ToolFilterContext): Tool[] {
    return materializeToolsForLLM(filter, this.mergedToolView(), {
      enabledFeatures: this._enabledFeatures,
      safetyDisabled: this.computeSafetyDisabled(),
    });
  }

  /** Paired with `getToolsForLLM` — hints filtered the same way. */
  getToolPromptHints(filter?: ToolFilterContext): string[] {
    return materializeToolPromptHints(filter, this.mergedToolView(), {
      enabledFeatures: this._enabledFeatures,
    });
  }

  /**
   * Replace this engine's enabled-features set. Tools tagged
   * `feature: "X"` are hidden until "X" is in here. Independent of
   * the process-global enabledFeatures (legacy).
   *
   * Hosts typically call this once at boot after resolving the
   * feature config (cli's `initFeatureRuntime` returns the resolved
   * set; build-engine.ts threads it onto the engine here).
   */
  setEnabledFeatures(names: Iterable<string>): void {
    this._enabledFeatures.clear();
    for (const n of names) this._enabledFeatures.add(n);
  }

  /** Per-engine view of which tools the safety config has `disabled: true`. */
  private computeSafetyDisabled(): Set<string> {
    const out = new Set<string>();
    const rules = this.config.safety.toolRules ?? {};
    for (const [name, rule] of Object.entries(rules)) {
      if (rule.disabled === true) out.add(name);
    }
    return out;
  }

  /**
   * Engine-instance tools merged with the process-global registry.
   * Engine entries win on name conflict (matches `resolveTool`'s
   * precedence). Returns a fresh Map so callers' mutations don't leak
   * back into either registry.
   */
  private mergedToolView(): Map<string, RegisteredTool> {
    const merged = new Map<string, RegisteredTool>();
    // Global first, engine overrides — preserves the resolveTool
    // precedence (engine wins) while keeping global registration order
    // for tools that exist only in the global registry.
    for (const name of listGlobalToolNames()) {
      const g = getGlobalTool(name);
      if (g) merged.set(name, g);
    }
    for (const [name, t] of this.tools) {
      merged.set(name, t);
    }
    return merged;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.options.persistence.close();
    this.tools.clear();
    this.closed = true;
  }

  /**
   * Last orphan-recovery report from construction. Null until
   * `runOrphanRecovery` finishes (which `createHukoEngine` awaits
   * before returning). When persistence didn't support recovery,
   * the report is the empty shape; never null after construction.
   */
  recoveryReport: RecoveryReport | null = null;

  /**
   * Run the engine's orphan-recovery scan against `this.options.persistence`.
   * Called automatically by `createHukoEngine`; exposed here so the
   * sync-construction escape hatch (`createHukoEngineSync`) can opt
   * in manually if a host decides recovery IS needed.
   *
   * Idempotent — calling twice in a row finds nothing on the second
   * run. Per-record callback (`hostHooks.onOrphanRecovered`) fires
   * once per healed task. Callback exceptions are swallowed.
   */
  async runOrphanRecovery(): Promise<RecoveryReport> {
    const report = await recoverOrphans(this.options.persistence);
    this.recoveryReport = report;
    const cb = this.options.onOrphanRecovered;
    if (cb && report.records.length > 0) {
      for (const record of report.records) {
        try {
          cb(record);
        } catch {
          /* observability callback failure is non-fatal */
        }
      }
    }
    return report;
  }
}

// ─── HukoAgent ──────────────────────────────────────────────────────────────

export class HukoAgent {
  readonly sessionId: number;
  readonly sessionType: SessionType;

  // Internal state — session-scoped resources.
  private sessionContextCached: SessionContext | null = null;
  private liveTask:
    | { taskId: number; loop: TaskLoop; completion: Promise<TaskRunSummary> }
    | null = null;

  private readonly askResolvers = new Map<string, AskResolver>();
  private readonly decisionResolvers = new Map<string, DecisionResolver>();

  private readonly askSubscribers = new Set<(e: AskUserEvent) => void>();
  private readonly decisionSubscribers = new Set<
    (e: DecisionRequiredEvent) => void
  >();
  private readonly eventSubscribers = new Set<(e: HukoEvent) => void>();

  constructor(
    private readonly engine: HukoEngine,
    readonly options: HukoAgentOptions,
  ) {
    this.sessionId = options.sessionId;
    this.sessionType = options.sessionType ?? "chat";
  }

  /** Effective persistence: agent override beats engine default. */
  private persistence(): AgentPersistence {
    return this.options.persistence ?? this.engine.options.persistence;
  }

  /** Effective provider: per-turn override beats agent default. */
  private resolveProvider(input: StartTurnInput): Provider {
    const p = input.provider ?? this.options.defaultProvider;
    if (!p) {
      throw new Error(
        `Agent "${this.options.name}" has no defaultProvider and the turn was started without one`,
      );
    }
    return p;
  }

  // ── SessionContext caching ─────────────────────────────────────────────────

  private async getOrCreateSessionContext(): Promise<SessionContext> {
    if (this.sessionContextCached) return this.sessionContextCached;
    const persistence = this.persistence();
    const initialContext = await persistence.loadInitialContext(
      this.sessionId,
      this.sessionType,
    );
    const emitter = {
      emit: (event: HukoEvent): void => this.dispatchEvent(event),
    };
    this.sessionContextCached = new SessionContext({
      sessionId: this.sessionId,
      sessionType: this.sessionType,
      persist: persistence.persist,
      updateDb: persistence.update,
      emitter,
      initialContext,
      ...(this.options.scrubText ? { scrubText: this.options.scrubText } : {}),
      ...(this.options.expandArgs ? { expandArgs: this.options.expandArgs } : {}),
    });
    return this.sessionContextCached;
  }

  // ── Event dispatch ─────────────────────────────────────────────────────────

  private dispatchEvent(event: HukoEvent): void {
    for (const sub of this.eventSubscribers) {
      try {
        sub(event);
      } catch (err) {
        process.stderr.write(
          `huko: event subscriber threw: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
    if (event.type === "ask_user") {
      for (const sub of this.askSubscribers) {
        try {
          sub(event);
        } catch (err) {
          process.stderr.write(
            `huko: ask_user subscriber threw: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    } else if (event.type === "decision_required") {
      for (const sub of this.decisionSubscribers) {
        try {
          sub(event);
        } catch (err) {
          process.stderr.write(
            `huko: decision_required subscriber threw: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }
    }
  }

  onEvent(handler: (event: HukoEvent) => void): () => void {
    this.eventSubscribers.add(handler);
    return () => {
      this.eventSubscribers.delete(handler);
    };
  }

  onAskUser(handler: (event: AskUserEvent) => void): () => void {
    this.askSubscribers.add(handler);
    return () => {
      this.askSubscribers.delete(handler);
    };
  }

  onDecision(handler: (event: DecisionRequiredEvent) => void): () => void {
    this.decisionSubscribers.add(handler);
    return () => {
      this.decisionSubscribers.delete(handler);
    };
  }

  // ── Ask / Decision registries ──────────────────────────────────────────────

  pendingAsks(): PendingAsk[] {
    const out: PendingAsk[] = [];
    for (const [toolCallId, r] of this.askResolvers) {
      out.push({
        toolCallId,
        taskId: r.taskId,
        question: r.question,
        ...(r.options ? { options: r.options } : {}),
        ...(r.selectionType ? { selectionType: r.selectionType } : {}),
        ts: r.ts,
      });
    }
    return out;
  }

  pendingDecisions(): PendingDecision[] {
    const out: PendingDecision[] = [];
    for (const [toolCallId, r] of this.decisionResolvers) {
      out.push({ toolCallId, taskId: r.taskId });
    }
    return out;
  }

  respondToAsk(
    toolCallId: string,
    reply: { content: string; attachments?: UserAttachment[] },
  ): boolean {
    const r = this.askResolvers.get(toolCallId);
    if (!r) return false;
    this.askResolvers.delete(toolCallId);
    r.resolve(reply);
    return true;
  }

  respondToDecision(
    toolCallId: string,
    outcome: { kind: "allow" | "deny" | "allow_and_remember" },
  ): boolean {
    const r = this.decisionResolvers.get(toolCallId);
    if (!r) return false;
    this.decisionResolvers.delete(toolCallId);
    r.resolve(outcome);
    return true;
  }

  private abortAsksForTask(taskId: number, err: Error): void {
    for (const [toolCallId, r] of this.askResolvers) {
      if (r.taskId !== taskId) continue;
      this.askResolvers.delete(toolCallId);
      r.reject(err);
    }
  }

  private abortDecisionsForTask(taskId: number, err: Error): void {
    for (const [toolCallId, r] of this.decisionResolvers) {
      if (r.taskId !== taskId) continue;
      this.decisionResolvers.delete(toolCallId);
      r.reject(err);
    }
  }

  // ── Live-task control ──────────────────────────────────────────────────────

  liveTaskId(): number | null {
    return this.liveTask?.taskId ?? null;
  }

  /**
   * Stop the live task (if any). Returns true when a task was stopped,
   * false when no task was live. Pending asks/decisions on this task
   * are rejected with a "stopped while waiting" error so callers
   * awaiting them don't hang.
   */
  stop(): boolean {
    if (!this.liveTask) return false;
    const err = new Error("Task stopped while waiting for user reply");
    this.abortAsksForTask(this.liveTask.taskId, err);
    this.abortDecisionsForTask(this.liveTask.taskId, err);
    this.liveTask.loop.stop();
    return true;
  }

  // ── runTurn / startTurn ────────────────────────────────────────────────────

  /**
   * Convenience: collect events into a buffer, start the turn, await
   * completion, return the summary + events. Useful when one HTTP
   * request maps to one turn that returns one JSON response.
   */
  async runTurn(input: StartTurnInput): Promise<AgentTurnResult> {
    const events: HukoEvent[] = [];
    const unsubscribe = this.onEvent((e) => events.push(e));
    try {
      const handle = await this.startTurn(input);
      const summary = await handle.completion;
      return {
        sessionId: this.sessionId,
        taskId: handle.taskId,
        status: summary.status,
        finalResult: summary.finalResult,
        errorMessage: this.errorMessageFromSummary(summary),
        promptTokens: summary.promptTokens,
        completionTokens: summary.completionTokens,
        totalTokens: summary.totalTokens,
        toolCallCount: summary.toolCallCount,
        iterationCount: summary.iterationCount,
        events,
      };
    } finally {
      unsubscribe();
    }
  }

  private errorMessageFromSummary(summary: TaskRunSummary): string | null {
    if (summary.status === "failed") {
      return summary.finalResult || "task failed";
    }
    return null;
  }

  /**
   * Fire a new turn (or interject into the live one). Returns
   * immediately with a handle the host can await / track. Daemon
   * orchestrators use this shape so they can hold a TaskLoop reference
   * for stop/interject without blocking the request thread on the
   * full agent run.
   */
  async startTurn(input: StartTurnInput): Promise<TaskHandle> {
    if (this.liveTask) {
      if (input.interject) {
        return this.interjectIntoLive(input);
      }
      throw new Error(
        `Agent "${this.options.name}" already has a live task (taskId=${this.liveTask.taskId}); pass interject:true to merge into it`,
      );
    }
    return this.startNewTask(input);
  }

  private async interjectIntoLive(
    input: StartTurnInput,
  ): Promise<TaskHandle> {
    const live = this.liveTask;
    if (!live) throw new Error("interjectIntoLive called without a live task");

    // Abort any in-flight ask on this task FIRST — the operator typed
    // a new message instead of answering. The aborted ask returns a
    // structured `ask_aborted` tool_result to the LLM (see
    // server/task/tools/server/message.ts handleAsk), then the new
    // operator message is interjected as normal.
    this.abortAsksForTask(
      live.taskId,
      new Error("operator sent a new message instead of replying"),
    );
    if (live.loop.ctx.currentToolPromise) {
      await live.loop.ctx.currentToolPromise;
    }

    const sessionContext = await this.getOrCreateSessionContext();
    const metadata =
      input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments as UserAttachment[] }
        : undefined;
    await sessionContext.append({
      taskId: live.taskId,
      kind: EntryKind.UserMessage,
      role: "user",
      content: input.message,
      ...(metadata !== undefined ? { metadata } : {}),
    });
    live.loop.interject();
    return {
      taskId: live.taskId,
      interjected: true,
      completion: live.completion,
    };
  }

  private async startNewTask(input: StartTurnInput): Promise<TaskHandle> {
    const persistence = this.persistence();
    const provider = this.resolveProvider(input);
    const lean = input.lean ?? this.options.profile === "lean";
    const interactive = input.interactive ?? this.options.interactive ?? true;

    // Tool filter — lean defaults to bash-only when host doesn't pin.
    const effectiveCwd = input.cwd ?? this.options.cwd;

    let tools: Tool[];
    let promptHints: string[];
    if (input.toolsMaterialized !== undefined) {
      tools = [...input.toolsMaterialized];
      promptHints = [...(input.toolPromptHints ?? [])];
    } else {
      const allowList = input.toolsAllow
        ? input.toolsAllow
        : lean && !this.options.tools?.allow
          ? ["bash"]
          : (this.options.tools?.allow ?? []);
      const allow = new Set(allowList);
      tools = this.engine.materializeTools(allow);
      promptHints = this.engine.materializePromptHints(allow);
    }

    // System prompt — lean vs full has its own composer.
    const workingLanguage =
      input.workingLanguage ?? this.options.workingLanguage ?? null;
    let systemPrompt: string;
    if (lean) {
      systemPrompt = assembleLeanSystemPrompt({
        workingLanguage,
        ...(this.options.currentDate
          ? { currentDate: this.options.currentDate }
          : {}),
      });
    } else {
      const overlays: PromptOverlay[] = [
        ...(this.options.overlays ?? []),
        ...(input.extraOverlays ?? []),
      ];
      const skills = input.skills ?? this.options.skills ?? [];
      const projectContext =
        input.projectContext !== undefined
          ? input.projectContext
          : (this.options.projectContext ?? null);
      const scheduledTask =
        input.scheduledTask ?? this.options.scheduledTask;
      systemPrompt = assembleSystemPrompt({
        workingDirectory: effectiveCwd ?? ".",
        platform: this.options.platform ?? "unknown",
        workingLanguage,
        ...(this.options.currentDate
          ? { currentDate: this.options.currentDate }
          : {}),
        toolHints: promptHints,
        skills,
        projectContext,
        ...(scheduledTask ? { scheduledTask } : {}),
        overlays,
      });
    }

    const sessionContext = await this.getOrCreateSessionContext();
    const userMetadata =
      input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments as UserAttachment[] }
        : undefined;

    // Atomic create-task + persist-user-message when persistence
    // supports it; two-step fallback otherwise.
    const sessionOwnership =
      this.sessionType === "chat"
        ? { chatSessionId: this.sessionId, agentSessionId: null }
        : { chatSessionId: null, agentSessionId: this.sessionId };

    let taskId: number;
    let knownEntryId: number | undefined;
    if (persistence.createTaskWithInitialEntry) {
      const res = await persistence.createTaskWithInitialEntry({
        task: {
          ...sessionOwnership,
          modelId: provider.modelId,
          toolCallMode: provider.toolCallMode,
          thinkLevel: provider.thinkLevel,
          status: "running",
        },
        entry: {
          sessionId: this.sessionId,
          sessionType: this.sessionType,
          kind: EntryKind.UserMessage,
          role: "user",
          content: input.message,
          ...(userMetadata !== undefined ? { metadata: userMetadata } : {}),
        },
      });
      taskId = res.taskId;
      knownEntryId = res.entryId;
    } else {
      taskId = await persistence.createTask({
        ...sessionOwnership,
        modelId: provider.modelId,
        toolCallMode: provider.toolCallMode,
        thinkLevel: provider.thinkLevel,
        status: "running",
      });
    }

    // Persist the system prompt as its own entry (debug surface; not
    // LLM-visible — it's passed to callLLM as the `system` field).
    await sessionContext.append({
      taskId,
      kind: EntryKind.SystemPrompt,
      role: "system",
      content: systemPrompt,
      metadata: { profile: lean ? "lean" : "full" },
    });

    // Push the user message onto sessionContext's llmContext + event
    // bus. `knownEntryId` skips the DB write when the persistence
    // already wrote it transactionally above.
    const appendUserMetadata =
      userMetadata !== undefined ? { metadata: userMetadata } : {};
    if (knownEntryId !== undefined) {
      await sessionContext.append(
        {
          taskId,
          kind: EntryKind.UserMessage,
          role: "user",
          content: input.message,
          ...appendUserMetadata,
        },
        { knownEntryId },
      );
    } else {
      await sessionContext.append({
        taskId,
        kind: EntryKind.UserMessage,
        role: "user",
        content: input.message,
        ...appendUserMetadata,
      });
    }

    // Build interactivity hooks (waitForReply + requestDecision).
    const taskRefForHooks = { taskId };
    const waitForReply = interactive
      ? this.buildWaitForReply(taskRefForHooks, sessionContext, persistence)
      : undefined;
    const requestDecision: RequestDecisionCallback | undefined = interactive
      ? this.buildRequestDecision(taskRefForHooks, sessionContext, persistence)
      : undefined;

    const sessionDiscrim =
      this.sessionType === "chat"
        ? ({ sessionType: "chat", chatSessionId: this.sessionId } as const)
        : ({ sessionType: "agent", agentSessionId: this.sessionId } as const);
    const taskContext = new TaskContext({
      taskId,
      ...sessionDiscrim,
      protocol: provider.protocol,
      modelId: provider.modelId,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      toolCallMode: provider.toolCallMode,
      thinkLevel: provider.thinkLevel,
      contextWindow: provider.contextWindow,
      ...(provider.headers !== undefined ? { headers: provider.headers } : {}),
      tools,
      systemPrompt,
      sessionContext,
      ...(waitForReply !== undefined ? { waitForReply } : {}),
      ...(requestDecision !== undefined ? { requestDecision } : {}),
      ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
      engine: this.engine,
      toolResolver: (name) => this.engine.resolveTool(name),
    });
    if (workingLanguage) taskContext.workingLanguage = workingLanguage;

    const loop = new TaskLoop(taskContext);
    const completion = loop.run().then(
      async (summary) => {
        await this.handleTaskDone(taskId, taskContext, summary);
        return summary;
      },
      async (err) => {
        await this.handleTaskCrash(taskId, err);
        throw err;
      },
    );

    this.liveTask = { taskId, loop, completion };
    return { taskId, interjected: false, completion };
  }

  private buildWaitForReply(
    taskRef: { taskId: number },
    sessionContext: SessionContext,
    persistence: AgentPersistence,
  ): NonNullable<
    ConstructorParameters<typeof TaskContext>[0]["waitForReply"]
  > {
    return async (payload) => {
      await persistence.updateTask(taskRef.taskId, {
        status: "waiting_for_reply",
      });
      const event: AskUserEvent = {
        type: "ask_user",
        taskId: taskRef.taskId,
        toolCallId: payload.toolCallId,
        question: payload.question,
        ...(payload.options ? { options: payload.options } : {}),
        ...(payload.selectionType ? { selectionType: payload.selectionType } : {}),
        ts: Date.now(),
      };
      sessionContext.emit(event);
      try {
        return await new Promise<{
          content: string;
          attachments?: UserAttachment[];
        }>((resolve, reject) => {
          this.askResolvers.set(payload.toolCallId, {
            taskId: taskRef.taskId,
            question: payload.question,
            ...(payload.options ? { options: payload.options } : {}),
            ...(payload.selectionType
              ? { selectionType: payload.selectionType }
              : {}),
            ts: event.ts,
            resolve,
            reject,
          });
        });
      } finally {
        this.askResolvers.delete(payload.toolCallId);
        try {
          await persistence.updateTask(taskRef.taskId, { status: "running" });
        } catch {
          /* already terminal — ignore */
        }
      }
    };
  }

  private buildRequestDecision(
    taskRef: { taskId: number },
    sessionContext: SessionContext,
    persistence: AgentPersistence,
  ): RequestDecisionCallback {
    return async (req) => {
      await persistence.updateTask(taskRef.taskId, {
        status: "waiting_for_reply",
      });
      const event: DecisionRequiredEvent = {
        type: "decision_required",
        taskId: taskRef.taskId,
        toolCallId: req.toolCallId,
        toolName: req.toolName,
        args: req.args,
        reason: req.reason,
        ...(req.matchedPattern !== undefined ? { matchedPattern: req.matchedPattern } : {}),
        ...(req.matchedField !== undefined ? { matchedField: req.matchedField } : {}),
        ...(req.matchedValue !== undefined ? { matchedValue: req.matchedValue } : {}),
        ts: Date.now(),
      };
      sessionContext.emit(event);
      try {
        return await new Promise<{
          kind: "allow" | "deny" | "allow_and_remember";
        }>((resolve, reject) => {
          this.decisionResolvers.set(req.toolCallId, {
            taskId: taskRef.taskId,
            resolve,
            reject,
          });
        });
      } finally {
        this.decisionResolvers.delete(req.toolCallId);
        try {
          await persistence.updateTask(taskRef.taskId, { status: "running" });
        } catch {
          /* already terminal — ignore */
        }
      }
    };
  }

  private async handleTaskDone(
    taskId: number,
    taskContext: TaskContext,
    summary: TaskRunSummary,
  ): Promise<void> {
    const persistence = this.persistence();
    const persistStatus: TaskStatus =
      summary.status === "done" ||
      summary.status === "failed" ||
      summary.status === "stopped"
        ? summary.status
        : "running";
    const errorMessage = taskContext.taskFailed
      ? summary.finalResult || "task failed"
      : null;
    await persistence.updateTask(taskId, {
      status: persistStatus,
      finalResult: summary.finalResult,
      promptTokens: taskContext.promptTokens,
      completionTokens: taskContext.completionTokens,
      totalTokens: taskContext.totalTokens,
      toolCallCount: taskContext.toolCallCount,
      iterationCount: taskContext.iterationCount,
      ...(errorMessage !== null ? { errorMessage } : {}),
    });
    if (this.liveTask?.taskId === taskId) this.liveTask = null;
  }

  private async handleTaskCrash(taskId: number, err: unknown): Promise<void> {
    const persistence = this.persistence();
    const message = err instanceof Error ? err.message : String(err);
    try {
      await persistence.updateTask(taskId, {
        status: "failed",
        errorMessage: message,
      });
    } catch {
      /* persistence failure on crash — already in a bad state */
    }
    if (this.liveTask?.taskId === taskId) this.liveTask = null;
  }

  /**
   * Release agent resources — abort live task, reject pending
   * asks/decisions, clear caches. Safe to call repeatedly.
   */
  async close(): Promise<void> {
    if (this.liveTask) {
      this.liveTask.loop.stop();
      const closingErr = new Error("agent closing");
      this.abortAsksForTask(this.liveTask.taskId, closingErr);
      this.abortDecisionsForTask(this.liveTask.taskId, closingErr);
      try {
        await this.liveTask.completion;
      } catch {
        /* loop.stop() typically resolves the completion cleanly; even
           when it doesn't, we're tearing down. */
      }
    }
    this.askSubscribers.clear();
    this.decisionSubscribers.clear();
    this.eventSubscribers.clear();
    this.sessionContextCached = null;
  }
}

// ─── createHukoEngine ───────────────────────────────────────────────────────

/**
 * Construct a `HukoEngine` and run any first-boot housekeeping the
 * engine owns — currently the orphan-recovery scan + foundational
 * tool registration. Async because recovery touches persistence;
 * await this once at host bootstrap and hand the resolved engine to
 * the rest of the host.
 *
 * Defaults applied at construction (override via options):
 *   - `foundationalTools: true` — engine registers the 13 bundled
 *     tools (bash / glob / grep / plan / message / ...) so hosts
 *     can allow-list them per agent without separate wiring. Opt out
 *     with `foundationalTools: false`.
 *   - `hostHooks.bestPracticesProvider: defaultBestPracticesProvider`
 *     when host doesn't supply one. Explicit `null` opts out;
 *     explicit function overrides.
 *
 * Automatic orphan-recovery scan: persistence implementations without
 * `listNonTerminalTasks` (MemoryAgentPersistence, stub backends,
 * anything that can't survive a crash) skip the scan silently.
 * SqliteAgentPersistence implements the methods and gets full
 * recovery. Hosts that want visibility pass `onOrphanRecovered`.
 */
export async function createHukoEngine(
  options: HukoEngineOptions,
): Promise<HukoEngine> {
  const engine = new HukoEngine(options);
  if (options.foundationalTools !== false) {
    registerFoundationalTools(engine);
  }
  await engine.runOrphanRecovery();
  return engine;
}

/**
 * Synchronous escape hatch — same construction as `createHukoEngine`
 * but WITHOUT the automatic orphan-recovery scan. Intended for
 * tests + scripts that build an engine against in-memory persistence
 * where recovery is meaningless anyway, and for callers who can't
 * await the construction (rare).
 *
 * Production hosts should prefer the async factory; missing
 * recovery is a real correctness gap when the persistence backend
 * outlives the process.
 *
 * Foundational-tools registration + bestPracticesProvider default
 * still apply (they don't need async).
 */
export function createHukoEngineSync(options: HukoEngineOptions): HukoEngine {
  const engine = new HukoEngine(options);
  if (options.foundationalTools !== false) {
    registerFoundationalTools(engine);
  }
  return engine;
}

// Re-export recovery types so hosts using `onOrphanRecovered` can
// name them.
export type { OrphanRecord, RecoveryReport };

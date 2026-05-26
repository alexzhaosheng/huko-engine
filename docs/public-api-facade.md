# Public API facade

## Why this matters

`huko-engine` is meant to be an agent engine, not a bag of runtime parts.
Today embedders directly import `TaskLoop`, `TaskContext`, `SessionContext`,
prompt assembly helpers, the tool registry, and low-level pipeline pieces.
That made sense while `huko-cli` was the only host. It is the wrong default
for new hosts such as `app-studio`.

The strongest agent behavior in huko comes from the combination of:

- the canonical system prompt blocks (identity, scope, principles, agent loop,
  tool-use rules, error handling, safety, disclosure, …),
- the plan tool and best-practices injection,
- tool prompt hints rendered alongside the tool list,
- safety policy handling,
- session and task boundary reminders,
- context management and compaction,
- streaming event emission,
- persistence and resume semantics,
- the task loop itself.

If a host wires the loop manually it almost always reuses TaskLoop while
quietly dropping the prompt blocks, plan tool, skills injection, and project
context. `app-studio`'s first cut did exactly that — the build agent runs
through TaskLoop but its prompt is a hand-rolled string outside the engine's
agent framing.

The preferred public API should therefore be a high-level, configurable
`HukoEngine` facade. Low-level classes remain available for tests and advanced
integration, but they are not the first thing a host reaches for.

## Design principle

Engine public API describes **agent concepts**, not implementation objects.

Preferred concepts:

- Engine instance (one per logical agent system)
- Agent
- Persistence adapter
- Tool surface (filter, not registry mutation)
- Prompt overlays
- Provider (LLM endpoint + model config — host-constructed)
- Interaction adapter (UI hooks)
- Event stream
- Run / resume / stop operations

Internal or advanced concepts:

- `TaskLoop`, `TaskContext`, `SessionContext`
- pipeline steps (`callLLM`, `executeTools`, `manageContext`)
- raw tool registry mutation
- direct prompt block assembly

The host decides product semantics. The engine preserves the agent runtime
contract.

## No global state

The current engine relies on process-wide globals: `setEngineConfig`,
`setEngineDefaultCwd`, `setSafetyRulePersister`, `setBestPracticesProvider`,
and a single tool registry Map. The facade replaces all of them with
construction-time options on a `HukoEngine` instance:

- multiple engines may coexist in one process with separate tool registries,
  configs, and persistence adapters,
- tests construct a fresh instance per test — no `_resetForTests()` helpers,
- there is no order-dependent `installEngineHostHooks()` bootstrap step.

This is the load-bearing structural change. Everything else assumes it.

## Target shape

```ts
import {
  createHukoEngine,
  SqliteAgentPersistence,
  MemoryAgentPersistence,
  type Provider,
  type AgentPersistence,
  type PromptOverlay,
  type HukoEvent,
} from "@alexzhaosheng/huko-engine";

const engine = createHukoEngine({
  persistence: new SqliteAgentPersistence(".huko/system-chat.db"),
  interaction: {                    // optional UI bridge
    waitForReply,
    requestDecision,
  },
  safety: hukoConfig.safety,        // optional; engine has sensible defaults
  bestPracticesProvider,            // optional; for plan-tool role text
});

engine.registerTool({               // instance-scoped registry
  name: "write_definition_file",
  description: "...",
  parameters: { type: "object", ... },
  dangerLevel: "moderate",
  promptHint: () => "Prefer write_definition_file over bash for ...",
  handler,
});

const agent = engine.createAgent({
  name: "app-studio-build-agent",
  profile: "full",                  // selects the base prompt template
  cwd: app.directory,
  persistence: new SqliteAgentPersistence(
    `apps/${app.id}/runtime/build-agent.db`,
  ),                                // overrides engine default
  defaultProvider: claudeProvider,
  tools: { allow: ["message", "plan", "write_definition_file"] },
  overlays: [
    { name: "role", content: buildAgentRoleText(), position: "tail" },
    { name: "app-context", content: renderAppContext(app), position: "tail" },
    {
      name: "definition-schemas",
      content: DEFINITION_SCHEMAS_TEXT,
      position: "tail",
    },
    { name: "compiled-definition", content: JSON.stringify(compiled), position: "tail" },
  ],
});

const { events, completion } = agent.startTurn({ sessionId, message });
for await (const event of events) socket.emit("huko", event);
const result = await completion;

await engine.close();               // closes SQLite handles, drops registry
```

Equivalent batch form (no streaming concern):

```ts
const result = await agent.runTurn({ sessionId, message });
```

## Agent profile

`profile: "lean" | "full"` ONLY selects which base prompt blocks render.
Tool surface, persistence, cwd, overlays, and default provider are independent
knobs on `createAgent`. No "profile X turns Y on" shortcuts — they break
down as soon as a fourth combination is asked for.

## Provider

Engine defines the `Provider` type:

```ts
type Provider = {
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  modelId: string;
  toolCallMode: ToolCallMode;
  thinkLevel: ThinkLevel;
  contextWindow: number;
};
```

Engine does NOT know about OpenRouter / Anthropic / private gateways. It does
not resolve API key references (`~/.huko/keys.json`, env, vault). Engine takes
Provider objects as data; the host constructs them however its config layer
wants.

Provider lives at two levels:

- `agent.defaultProvider` — most common case; the agent uses the same model
  every turn,
- `runTurn({ provider })` — per-turn override (rare; e.g. "try a smaller
  model for this one").

## Persistence

Engine defines the interface and ships two implementations.

### Interface

```ts
interface AgentPersistence {
  persist: PersistFn;
  update: UpdateFn;
  loadInitialContext(sessionId: number, sessionType: SessionType): Promise<LLMMessage[]>;
  createSession(input: CreateSessionInput): Promise<number>;
  createTask(input: CreateTaskInput): Promise<number>;
  updateTask(id: number, patch: UpdateTaskPatch): Promise<void>;
  close(): Promise<void> | void;
}
```

Six methods. Anything more elaborate (listing sessions for a UI, resuming
non-terminal tasks, redaction substitutions, schedule-owned sessions) is a
host concern — those wrap or extend this adapter, they don't widen the
engine's contract.

### Built-ins

```ts
import { SqliteAgentPersistence, MemoryAgentPersistence } from "@alexzhaosheng/huko-engine/persistence";

new SqliteAgentPersistence("/abs/path/agent.db");
new MemoryAgentPersistence();
```

- `SqliteAgentPersistence` — production-ready for hosts that don't want to
  hand-roll storage. Owns schema migration, WAL pragmas, atomic writes.
- `MemoryAgentPersistence` — for tests + short-lived agents; close()'s a no-op.

`app-studio`'s current `StudioPersistence` (~470 lines) collapses entirely
once this lands.

### Override at agent level

Engine takes a default persistence. Agents may pass their own (different
file, different backend) — useful for `app-studio` where the build-agent and
app-agent each have their own SQLite file per app, while the global basic
agent shares one studio.db.

## Prompt overlays

Engine owns the canonical base prompt; hosts contribute overlays that
EXTEND it. Overlays cannot replace base blocks.

```ts
type PromptOverlay = {
  /** Stable identifier (debugging, tracing, prompt-cache invalidation). */
  name: string;
  /** Rendered text; engine inserts verbatim. */
  content: string;
  /**
   * Where in the canonical order to insert. Default "tail" — between
   * project_context/scheduled_task and the cache boundary.
   */
  position?: "tail" | "after-skills" | "after-project-context";
};
```

Positions all sit at the cache-stable tail of the prefix — overlays never
go BEFORE the agent-loop / tool-use blocks, because that would break prompt
caching for hosts that share the base prefix.

### Tool prompt hints (the invariant)

The LLM-visible tool list and tool prompt hints share the same filter.

Each tool registration may declare `promptHint`:

```ts
engine.registerTool({
  name: "write_definition_file",
  description: "...",
  parameters: { ... },
  promptHint: () => "Prefer write_definition_file over bash for app definition edits.",
  handler,
});
```

When `createAgent({ tools: { allow: ["write_definition_file"] } })` filters
the registry, the matching `promptHint` calls feed `<tool_use>` rendering.
A tool that's filtered OUT contributes neither its description nor its hint.
This invariant is enforced inside the facade — the host can't accidentally
desync them.

## Interaction hooks

Hosts differ in UI. Engine exposes stable hooks:

- `waitForReply` — for `message(type=ask)` blocking input
- `requestDecision` — safety-policy approval prompts
- event stream — `agent.startTurn` returns `events: AsyncIterable<HukoEvent>`
- `agent.startTurn` returns a handle with `interject()` / `stop()` for
  interactive shells; `runTurn` is the fire-and-forget sugar

If a hook is absent, the engine fails closed with a clear error.

## App-studio as the forcing case

`app-studio` needs two app-scoped agents (build, app) plus a global basic
agent. All three should inherit huko's full agent behavior. Their differences
are overlays + tools + persistence file + cwd — never loop semantics.

```ts
const buildAgent = engine.createAgent({
  name: "app-studio-build-agent",
  profile: "full",
  cwd: app.directory,
  persistence: new SqliteAgentPersistence(
    `apps/${app.id}/runtime/build-agent.db`,
  ),
  defaultProvider: claudeProvider,
  tools: { allow: ["message", "plan", "write_definition_file"] },
  overlays: [
    { name: "role", content: buildAgentRoleText() },
    { name: "app-context", content: renderAppContext(app) },
    { name: "definition-schemas", content: DEFINITION_SCHEMAS_TEXT },
    { name: "compiled-definition", content: JSON.stringify(compiled) },
  ],
});
```

App-studio's current `agent-runner.ts` (170 lines, hand-rolls
`SessionContext` + `TaskContext` + `TaskLoop`) and the per-route system-prompt
strings collapse into this. App-studio stays focused on product meaning;
engine carries the agent.

## Migration plan

App-studio first — it's the smaller, cleaner pilot (one short route handler
and one runner, both written last week). Once the facade is proven there,
cli's orchestrator follows.

1. ✅ Add `PromptOverlay` type + integrate with `assembleSystemPrompt` so
   structured overlays render at the chosen position.
2. ✅ Write a regression test: feed today's cli prompt inputs through the new
   overlay machinery and assert byte-identity with the current output.
3. ✅ Add `AgentPersistence` interface + `SqliteAgentPersistence` +
   `MemoryAgentPersistence`. Pass app-studio's current sqlite tests against
   it.
4. ✅ Add `createHukoEngine` + `HukoAgent` facade. Internally uses TaskLoop /
   TaskContext / SessionContext; externally the host never sees them.
5. ✅ Migrate `app-studio` build agent + system chat to the facade. Delete
   `agent-runner.ts` + most of `persistence.ts`.
6. ✅ Migrate `huko-cli` orchestrator to the facade. Largest mechanical work.
   Required growing the facade to cover daemon needs: `startTurn → TaskHandle`,
   `agent.stop / liveTaskId / interject`, per-agent ask/decision registries,
   `onEvent / onAskUser / onDecision` subscribers, per-turn `lean / scheduled /
   interactive / setupAssistant / attachments`, `scrubText / expandArgs`
   hooks, `HukoEngineHostHooks` (config / defaultCwd / safetyRulePersister /
   bestPracticesProvider) installed through the engine constructor.
   `install-engine-host-hooks.ts` deleted in favour of `buildEngineForCli`.
7. ✅ Mark `TaskLoop` / `TaskContext` / `SessionContext` / `assembleSystemPrompt`
   / `assembleLeanSystemPrompt` / `recoverOrphans` / `registerServerTool` as
   `@internal` in doc comments. Subpath exports remain for engine tests +
   transitional host paths; new hosts use the public facade barrel.
   `Emitter` was promoted onto the public barrel so daemon transports stop
   needing the `SessionContext` subpath.

### Still on the wishlist

- Threading the engine instance through `TaskContext` so the engine's
  config / defaultCwd / safetyRulePersister / bestPracticesProvider live
  on the instance (today the constructor installs them into 48 module-
  level callsites — last engine wins, fine for single-engine processes,
  not fine if a process ever wants two engines with different hooks).
- A real `huko-engine/internal/*` subpath partition once the engine
  package ships outside the monorepo; for now the `@internal` JSDoc tag
  carries the signal and avoids breaking transitional callsites.

## Non-goals

- Do not move app-studio product semantics into engine.
- Do not make engine depend on Express, React, SQLite (engine ships a
  sqlite adapter, but the engine core stays storage-agnostic), or CLI config
  files.
- Do not remove low-level APIs.
- Do not freeze the facade shape before migrating at least one real host.

## Success criteria

- A new host runs a capable huko agent without importing `TaskLoop`,
  `TaskContext`, `SessionContext`, or the prompt assembler directly.
- CLI and app-studio share the same high-level run path.
- Host overlays extend the canonical engine prompt; they cannot replace
  base blocks.
- Tool descriptions and tool prompt hints are filtered together.
- Two engines in one process work, with isolated tool registries +
  persistence + config.
- Task failure, stop, resume, safety prompts, and ask-user flows behave
  consistently across hosts.

A minimal host should fit in ~10 lines:

```ts
const engine = createHukoEngine({ persistence: new MemoryAgentPersistence() });
const agent = engine.createAgent({
  profile: "full",
  defaultProvider: myProvider,
});
const result = await agent.runTurn({ message: "hello, who are you" });
console.log(result.finalResult);
await engine.close();
```

If this doesn't work, the facade is over-engineered.

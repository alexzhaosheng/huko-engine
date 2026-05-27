# Public API facade

Why the facade looks the way it does. Design rationale for the
`createHukoEngine` + `HukoAgent` + `AgentPersistence` surface that
sits at the top of `@alexzhaosheng/huko-engine`.

For day-to-day usage, the [README](../README.md) is the right entry;
for copy-pasteable recipes see [`cookbook.md`](cookbook.md). This
doc explains the shape *itself*.

## Why a facade

`huko-engine` is meant to be an agent engine, not a bag of runtime
parts. Without a facade, embedders end up importing `TaskLoop`,
`TaskContext`, `SessionContext`, prompt assembly helpers, the tool
registry, and low-level pipeline pieces directly — and inevitably
drop one or more of the load-bearing pieces in the process.

The strongest agent behavior in huko comes from the combination of:

- the canonical system prompt blocks (identity, scope, principles,
  agent loop, tool-use rules, error handling, safety, disclosure, …),
- the plan tool and best-practices injection,
- tool prompt hints rendered alongside the tool list,
- safety policy handling,
- session and task boundary reminders,
- context management and compaction,
- streaming event emission,
- persistence and resume semantics,
- the task loop itself.

A host wiring the loop manually almost always reuses TaskLoop while
quietly losing the prompt blocks, plan tool, skills injection, and
project context. The facade exists so that doesn't happen — calling
`createHukoEngine` + `engine.createAgent` gives you all of the above
by default, and host-specific knobs are explicit options on top.

## Design principle

Engine public API describes **agent concepts**, not implementation
objects.

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

Internal or advanced concepts (under `src/internal/`, not on the
exports map):

- `TaskLoop`, `TaskContext`, `SessionContext`
- pipeline steps (`callLLM`, `executeTools`, `manageContext`)
- raw tool registry mutation
- direct prompt block assembly

The host decides product semantics. The engine preserves the agent
runtime contract.

## No global state

Earlier engine builds relied on process-wide globals
(`setEngineConfig`, `setEngineDefaultCwd`, `setSafetyRulePersister`,
`setBestPracticesProvider`, a single tool registry Map). The facade
replaces all of them with construction-time options on a `HukoEngine`
instance:

- multiple engines may coexist in one process with separate tool
  registries, configs, and persistence adapters,
- tests construct a fresh instance per test — no `_resetForTests()`
  helpers,
- there is no order-dependent bootstrap step.

This is the load-bearing structural change. Everything else assumes
it.

## Target shape

```ts
import {
  createHukoEngine,
  SqliteAgentPersistence,
  type Provider,
  type PromptOverlay,
} from "@alexzhaosheng/huko-engine";

const engine = await createHukoEngine({
  persistence: new SqliteAgentPersistence(".huko/agent.db"),
  hostHooks: {                       // optional — see Host hooks
    safetyRulePersister: persistRule,
    bestPracticesProvider,
  },
});

engine.registerTool({                // instance-scoped registry
  name: "my_host_tool",
  description: "...",
  parameters: { type: "object", ... },
  dangerLevel: "moderate",
  promptHint: "Prefer my_host_tool over bash for …",
  handler,
});

const sessionId = await engine.createSession({ title: "demo" });

const agent = engine.createAgent({
  name: "demo",
  sessionId,
  profile: "full",                   // selects the base prompt template
  cwd: process.cwd(),
  defaultProvider: claudeProvider,
  tools: { allow: ["message", "plan", "my_host_tool"] },
  overlays: [
    { name: "role", content: roleText(), position: "tail" },
    { name: "context", content: renderContext(), position: "tail" },
  ],
});

const handle = await agent.startTurn({ message });
const unsub = agent.onEvent((event) => socket.emit("huko", event));
const result = await handle.completion;
unsub();

await engine.close();
```

Batch form (no streaming concern):

```ts
const result = await agent.runTurn({ message });
```

## Agent profile

`profile: "lean" | "full"` ONLY selects which base prompt blocks
render. Tool surface, persistence, cwd, overlays, and default
provider are independent knobs on `createAgent`. No "profile X turns
Y on" shortcuts — they break down as soon as a fourth combination is
asked for.

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

Engine does NOT know about OpenRouter / Anthropic / private
gateways. It does not resolve API key references
(`~/.huko/keys.json`, env, vault). Engine takes `Provider` objects as
data; the host constructs them however its config layer wants.

Provider lives at two levels:

- `agent.defaultProvider` — most common case; the agent uses the
  same model every turn,
- `runTurn({ provider })` — per-turn override (rare; e.g. "try a
  smaller model for this one").

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
  // optional orphan-recovery hooks
  listNonTerminalTasks?(): Promise<RecoverableTaskRow[]>;
  listEntriesForSession?(sessionId: number, sessionType: SessionType): Promise<RecoverableEntryRow[]>;
}
```

Anything more elaborate (listing sessions for a UI, redaction
substitutions, schedule-owned sessions) is a host concern — those
wrap or extend this adapter, they don't widen the engine's contract.

### Built-ins

```ts
import { SqliteAgentPersistence, MemoryAgentPersistence } from "@alexzhaosheng/huko-engine";

new SqliteAgentPersistence("/abs/path/agent.db");
new MemoryAgentPersistence();
```

- `SqliteAgentPersistence` — production-ready for hosts that don't
  want to hand-roll storage. Owns schema migration, WAL pragmas,
  atomic writes. Exposes a raw `db` handle for host-side queries
  the narrow interface doesn't cover.
- `MemoryAgentPersistence` — for tests + short-lived agents;
  `close()` is a no-op.

### Override at agent level

Engine takes a default persistence. Agents may pass their own
(different file, different backend) — useful when multiple
session-scoped agents need isolated storage while sharing the same
engine.

## Prompt overlays

Engine owns the canonical base prompt; hosts contribute overlays
that EXTEND it. Overlays cannot replace base blocks.

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

Positions all sit at the cache-stable tail of the prefix — overlays
never go BEFORE the agent-loop / tool-use blocks, because that would
break prompt caching for hosts that share the base prefix.

### Tool prompt hints (the invariant)

The LLM-visible tool list and tool prompt hints share the same
filter.

Each tool registration may declare `promptHint`:

```ts
engine.registerTool({
  name: "my_host_tool",
  description: "...",
  parameters: { ... },
  promptHint: "Prefer my_host_tool over bash for X.",
  handler,
});
```

When `createAgent({ tools: { allow: ["my_host_tool"] } })` filters
the registry, the matching `promptHint` strings feed `<tool_use>`
rendering. A tool that's filtered OUT contributes neither its
description nor its hint. This invariant is enforced inside the
facade — the host can't accidentally desync them.

## Interaction hooks

Hosts differ in UI. Engine exposes stable hooks:

- `onAsk(handler)` — for `message(type=ask)` blocking input; the
  host eventually calls `agent.respondToAsk(askId, reply)`.
- `onDecision(handler)` — safety-policy approval prompts; host
  calls `agent.respondToDecision(...)`.
- `onEvent(handler)` — stream every `HukoEvent`; returns an
  unsubscribe function.
- `startTurn(input)` returns a `TaskHandle` with `taskId` so the
  host can implement stop / interject on a live task; `runTurn` is
  the fire-and-forget sugar that awaits completion before returning.

If an interaction hook is absent and an agent issues the
corresponding flow, the engine fails closed with a clear error.

## Non-goals

- Do not move host-product semantics into engine.
- Do not make engine depend on Express, React, or CLI config files.
  (Engine ships a sqlite adapter because storage IS a kernel
  concern, but the engine core stays storage-agnostic via the
  `AgentPersistence` interface.)
- Do not remove low-level APIs from `src/internal/` — they're
  reachable from inside the engine package, just not exported.
- Do not freeze the facade shape before a second real host
  validates it.

## Success criteria

- A new host runs a capable huko agent without importing
  `TaskLoop`, `TaskContext`, `SessionContext`, or the prompt
  assembler directly.
- All engine consumers share the same high-level run path.
- Host overlays extend the canonical engine prompt; they cannot
  replace base blocks.
- Tool descriptions and tool prompt hints are filtered together.
- Two engines in one process work, with isolated tool registries +
  persistence + config.
- Task failure, stop, resume, safety prompts, and ask-user flows
  behave consistently across hosts.

A minimal host fits in ~10 lines:

```ts
const engine = await createHukoEngine({
  persistence: new MemoryAgentPersistence(),
});
const sessionId = await engine.createSession({ title: "demo" });
const agent = engine.createAgent({
  name: "demo",
  sessionId,
  defaultProvider: myProvider,
  tools: { allow: ["message", "plan"] },
});
const result = await agent.runTurn({ message: "hello, who are you" });
console.log(result.finalResult);
await engine.close();
```

See [`example/cli-chat/`](../example/cli-chat/) for a runnable
version. If this shape doesn't fit your host, the facade is
over-engineered — open an issue.

# @alexzhaosheng/huko-engine

Embeddable agent runtime — LLM protocol adapters, task loop, tool
framework, safety policy evaluator, skill loader, prompt assembler,
persistence. Drop it into any Node host process to run capable
agents through a small, opinionated facade.

This README is a usage guide. For the design rationale see
[`docs/public-api-facade.md`](docs/public-api-facade.md); for
package-internal rules see [`CLAUDE.md`](CLAUDE.md).

A reference host implementation lives in the
[**huko-cli**](https://github.com/alexzhaosheng/huko) repo — its
`packages/huko-cli/` shows a full daemon + CLI built on this engine
(orchestrator, scheduler, daemon transport, web UI, browser tool,
file-share, etc.). Reach for it when you want a worked example of
how each engine seam gets wired into a real host.

---

## Quick start

```ts
import {
  createHukoEngine,
  MemoryAgentPersistence,
} from "@alexzhaosheng/huko-engine";

const engine = await createHukoEngine({
  persistence: new MemoryAgentPersistence(),
});

const sessionId = await engine.createSession({ title: "demo" });

const agent = engine.createAgent({
  name: "demo-agent",
  sessionId,
  defaultProvider: {
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: process.env.OPENAI_API_KEY!,
    modelId: "gpt-4o",
    toolCallMode: "native",
    thinkLevel: "off",
    contextWindow: 128_000,
  },
  // 13 foundational tools (bash, glob, grep, plan, message, ...)
  // are auto-registered. Allow-list whichever ones this agent
  // should see — omit `tools` to expose none.
  tools: { allow: ["plan", "message", "bash", "read_file"] },
});

const result = await agent.runTurn({ message: "Hello, who are you?" });
console.log(result.finalResult);

await engine.close();
```

That's it — three things the host has to supply (`persistence`,
`defaultProvider`, `tools.allow`); everything else is defaults the
engine ships:

| Default | What it gets you |
|--------|-----------------|
| Foundational tools auto-registered | bash / glob / grep / plan / message / read_file / write_file / edit_file / delete_file / move_file / list_dir / web_fetch / web_search are all resolvable by name. Allow-list to expose. Opt out with `foundationalTools: false`. |
| `defaultBestPracticesProvider` | The plan tool's `tool_result` grows an "Expert Checklist" block for the 4 bundled capabilities (`coding`, `writing`, `research`, `analysis`) when an agent's plan phase tags one. Opt out with `hostHooks: { bestPracticesProvider: null }`. |
| Automatic orphan-recovery scan | At construction, engine scans persistence for tasks left in non-terminal state from a crashed previous run; marks them failed; injects synthetic `tool_result` rows for any dangling tool_calls so the next conversation continuation on the same session doesn't 400 on strict providers. Silent unless host passes `onOrphanRecovered`. `MemoryAgentPersistence` skips the scan. |

Want this as a runnable terminal demo? See
[`example/cli-chat/`](example/cli-chat/) — same shape with stdin
input, streamed output, and every foundational tool turned on. About
75 lines.

Daemons / orchestrators with live streaming, mid-flight stop, and
operator response routing reach for `startTurn` instead of
`runTurn` — see [Daemon patterns](#daemon-patterns).

`createHukoEngine` is async because of the orphan-recovery scan
above. For tests or scripts that don't need recovery,
`createHukoEngineSync(options)` constructs the engine without
awaiting the scan (defaults still apply).

---

## Install

```sh
npm install @alexzhaosheng/huko-engine
```

ESM-only; Node 20+. Native `better-sqlite3` is bundled — `npm install`
fetches a prebuilt binary for common platforms (linux/macos/windows
× x64/arm64).

The package ships as compiled JS + `.d.ts` declaration files under
`dist/`. The `publishConfig.exports` map enumerates the public
surface only — kernel primitives under `src/internal/` are NOT
reachable from the published package (npm consumers get
`ERR_PACKAGE_PATH_NOT_EXPORTED` for any `internal/*` import). The
facade barrel + a small set of curated subpaths (persistence types,
prompt overlay, registry, foundational tools, event types) are the
entire public surface.

---

## Core concepts

### `HukoEngine` (one per process)

Owns the per-instance tool registry, the default `AgentPersistence`,
and the host integration hooks (engine config, safety rule persister,
best-practices provider, default cwd). Constructed once at boot:

```ts
const engine = await createHukoEngine({
  persistence,                 // AgentPersistence
  hostHooks: {                 // optional — see Host hooks
    config: engineConfig,
    defaultCwd: process.cwd(),
    safetyRulePersister: (scope, cwd, tool, bucket, pattern) => { ... },
    bestPracticesProvider: async (phaseId, title, capabilities) => null,
  },
});
```

### `HukoAgent` (one per chat session)

Session-pinned — each agent represents one ongoing chat. The agent
caches its `SessionContext` for its lifetime so successive turns
share llmContext without replaying from persistence. Construct one
per session and cache it on the host (the huko CLI keeps a
`Map<sessionKey, HukoAgent>`):

```ts
const sessionId = await engine.createSession({ title: "chat 1" });
const agent = engine.createAgent({
  name: "chat-1",              // for debugging
  sessionId,                   // required — pinned for the agent's life
  defaultProvider,             // can be overridden per-turn
  cwd: "/path/to/project",     // for engine tools
  tools: { allow: ["bash", "edit_file"] },
  overlays: [...],             // host-supplied prompt extensions
  skills: [...],               // pre-loaded operator skills
  projectContext: "...",       // AGENTS.md / CLAUDE.md contents
});
```

### `AgentPersistence` (narrow contract)

Seven methods (six required + an optional atomic-create hook). Two
built-ins ship in the box; hosts can implement their own (remote
storage, multi-tenant sharded DB, custom audit). See
[Persistence](#persistence).

---

## Two entry shapes

### `runTurn(input) → Promise<AgentTurnResult>`

Convenience: starts the turn, awaits completion, collects events into
an array, returns the summary + events. The shape app-studio uses
(one HTTP request → one runTurn → one JSON response):

```ts
const result = await agent.runTurn({ message: "..." });
// result.{sessionId, taskId, status, finalResult, errorMessage,
//        promptTokens, completionTokens, totalTokens,
//        toolCallCount, iterationCount, events}
```

### `startTurn(input) → Promise<TaskHandle>`

Fire-and-track: returns immediately with `{taskId, interjected,
completion}`. The host awaits `completion` when it wants the final
summary and uses the live agent for `stop()` / `interject` /
`respondToAsk` in the meantime. The shape daemon orchestrators use:

```ts
const handle = await agent.startTurn({ message: "..." });
// kick off other work, listen for events, etc.
const summary = await handle.completion;
```

Both methods share the same `StartTurnInput`; `runTurn` is literally
`startTurn` + `await completion` + event-collection.

---

## Providers

LLM endpoint + model config. The engine takes `Provider` objects as
data — the host constructs them however its config layer wants
(keys.json, vault, environment variables, whatever). The engine
does NOT resolve API key references.

```ts
const provider: Provider = {
  protocol: "openai",          // | "anthropic" (engine handles both)
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-...",
  modelId: "gpt-4o",
  toolCallMode: "native",      // | "tool-call-emulation"
  thinkLevel: "off",           // | "low" | "medium" | "high"
  contextWindow: 128_000,
  headers: { "Custom-Header": "..." }, // optional
};
```

Per-turn override beats agent default:

```ts
const agent = engine.createAgent({
  name: "...",
  sessionId,
  defaultProvider: gpt4o,
});

await agent.runTurn({ message: "...", provider: gpt4oMini }); // one-off
```

---

## Persistence

### Built-ins

```ts
import {
  SqliteAgentPersistence,   // better-sqlite3, WAL pragma, 3-table schema
  MemoryAgentPersistence,   // Map-backed, for tests + short-lived agents
} from "@alexzhaosheng/huko-engine";

const sqlite = new SqliteAgentPersistence("/path/to/agent.db");
const memory = new MemoryAgentPersistence();
```

`SqliteAgentPersistence` exposes its underlying `db: Database.Database`
for hosts that need to run their own listing/admin queries without
widening the engine's contract.

### Custom

Implement the seven-method `AgentPersistence` interface:

```ts
interface AgentPersistence {
  persist: PersistFn;      // insert one entry, return its id
  update: UpdateFn;        // patch an existing entry's content/metadata
  loadInitialContext(sessionId, sessionType): Promise<LLMMessage[]>;
  createSession(input): Promise<number>;
  createTask(input): Promise<number>;
  updateTask(id, patch): Promise<void>;
  createTaskWithInitialEntry?(input): Promise<{taskId, entryId}>; // optional atomic
  close(): Promise<void> | void;
}
```

The optional `createTaskWithInitialEntry` lets long-running hosts
guarantee the "task row + initial entry" pair is written
transactionally — a crash between the two leaves no orphan task
without its first message. The facade uses it when available, falls
back to two-step writes otherwise.

A conformance test suite lives in
`tests/agent-persistence.test.ts` (in this repo) and runs the
same 8-test battery against any implementation — parametrise yours
into it when adding a new backend.

### Per-agent override

```ts
const customPersistence = new MyRemotePersistence(...);
const agent = engine.createAgent({
  name: "...",
  sessionId,
  persistence: customPersistence,   // overrides engine default
});
```

---

## Tools

### Registering host-defined tools

```ts
engine.registerTool({
  name: "write_definition_file",
  description: "Write the app's spec.yaml. Re-renders the build.",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string" },
      content: { type: "string" },
    },
    required: ["file", "content"],
  },
  dangerLevel: "moderate",
  promptHint:
    "Use write_definition_file to commit changes — never edit files inline.",
  handler: async (args, ctx) => {
    await applyWriteDefinitionFile(ctx.cwd, args.file, args.content);
    return "wrote " + args.file;
  },
});
```

`promptHint` is rendered into the system prompt's `<tool_use>` block
alongside the tool description. The host can't accidentally desync
description + hint — they're attached to the same record. When a
tool gets filtered out (not in `agent.tools.allow`), its hint goes
with it.

### Foundational tools (auto-registered by default)

The engine ships 13 foundational tools — bash, glob, grep, list_dir,
read_file, write_file, edit_file, delete_file, move_file, plan,
message, web_fetch, web_search — and registers them on the engine
instance automatically at construction. No imports, no wiring; just
allow-list whichever ones each agent should see:

```ts
const engine = await createHukoEngine({ persistence });
// All 13 are now resolvable by name; pick what to expose:
const agent = engine.createAgent({
  name: "...", sessionId, defaultProvider,
  tools: { allow: ["bash", "grep", "read_file"] },
});
```

Opt out when the host wants to replace a foundational tool with
its own (e.g. a sandboxed `bash`):

```ts
const engine = await createHukoEngine({
  persistence,
  foundationalTools: false,
});
engine.registerTool({ name: "bash", ..., handler: sandboxedBash });
// Optionally register the rest manually:
import {
  registerFoundationalTools,
  FOUNDATIONAL_TOOL_REGISTRATIONS,
} from "@alexzhaosheng/huko-engine";
// either register all of them, or filter the array:
for (const reg of FOUNDATIONAL_TOOL_REGISTRATIONS) {
  if (reg.name !== "bash") engine.registerTool(reg);
}
```

A tool being registered on the engine doesn't expose it to any LLM —
exposure is controlled per-agent via `tools.allow`. So the "all
foundational tools registered by default" stance is safe by default
even though `bash` is in there.

### Rich tool surface materialization

For hosts that need dynamic per-tool descriptions (platform notes,
lean materialization, interactive-mode parameter shaping — the huko
CLI does all three), compute the LLM-visible tool list off the engine
and pass it through. `engine.getToolsForLLM` / `engine.getToolPromptHints`
walk engine-instance tools merged with the process-global registry
(engine wins on conflicts), so host-registered tools show up alongside
foundational ones:

```ts
const filter = { interactive, lean, allowedTools };
const toolsMaterialized = engine.getToolsForLLM(filter);
const toolPromptHints = engine.getToolPromptHints(filter);

await agent.startTurn({
  message: "...",
  toolsMaterialized,
  toolPromptHints,
});
```

When `toolsMaterialized` is set, the facade uses it directly instead
of running its own allow-list materialization.

The bare `getToolsForLLM(filter)` / `getToolPromptHints(filter)` from
`@alexzhaosheng/huko-engine/task/tools/registry.js` walk ONLY the
process-global registry. Reach for them when a test or admin path
genuinely wants the global-only view; for an agent's LLM surface
always go through the engine method.

---

## Prompts

### Profile (full vs lean)

```ts
const agent = engine.createAgent({
  name: "...",
  sessionId,
  profile: "lean",   // ~300-token shell-only prompt; tool filter narrows to ["bash"]
});

// Per-turn toggle:
await agent.runTurn({ message: "...", lean: true });
```

### Overlays — extending the canonical prompt

Hosts cannot replace base blocks (identity, scope, principles,
agent_loop, tool_use, error_handling, local, safety, disclosure).
They insert at three named positions inside the cache-stable prefix:

```ts
const agent = engine.createAgent({
  name: "...",
  sessionId,
  overlays: [
    {
      name: "build-context",
      content: "<build_context>app: my-app, ...</build_context>",
      position: "after-project-context",
    },
    {
      name: "setup-assistant",
      content: "<setup_assistant>...</setup_assistant>",
      position: "tail",  // default — same slot as legacy extraOverlays
    },
  ],
});
```

Positions:
- `"after-skills"` — right after operator skills, before project context
- `"after-project-context"` — right after AGENTS.md / CLAUDE.md / HUKO.md
- `"tail"` — at the cache-stable tail (default; matches legacy
  `extraOverlays: string[]`)

All three sit INSIDE the prompt-cache-covered prefix — overlays
don't go before `<agent_loop>` because that would invalidate prompt
cache across hosts sharing the same base.

### Per-turn prompt inputs

`StartTurnInput` accepts per-turn overrides for everything the
prompt depends on:

```ts
await agent.startTurn({
  message: "...",
  skills: [...],                   // override agent.skills for this turn
  projectContext: "...",           // override agent.projectContext
  cwd: "/different/path",          // override agent.cwd
  workingLanguage: "中文",          // pin language for this turn
  scheduledTask: {                 // adds <scheduled_task> block
    cron: "0 9 * * *",
    timezone: "America/Los_Angeles",
    instructions: "Daily standup brief.",
  },
  extraOverlays: [...],            // merged on top of agent.overlays
});
```

### Attachments

```ts
await agent.runTurn({
  message: "What's in this image?",
  attachments: [
    { kind: "image", url: "https://...", mimeType: "image/png" },
  ],
});
```

---

## Daemon patterns

For hosts running many sessions concurrently (cli daemon, multi-app
servers), use `startTurn` for live control:

### Mid-flight stop

```ts
const handle = await agent.startTurn({ message: "..." });
// later, from a SIGINT handler or UI button:
agent.stop();   // aborts pending asks/decisions + tells the loop to wind down
```

### Interject (operator sends a new message while the agent is still working)

```ts
if (agent.liveTaskId() !== null) {
  await agent.startTurn({
    message: "actually never mind, do X instead",
    interject: true,    // appends to the live task; doesn't start a new one
  });
}
```

If `interject` is omitted and a live task exists, `startTurn`
throws — opt-in semantics prevent accidental clobbering.

### Subscribing to events

```ts
const unsubscribe = agent.onEvent((event) => {
  // event.type: "assistant_streaming_delta" | "task_started" |
  //             "tool_call_started" | "ask_user" | ...
  socket.emit("event", event);
});
// ...
unsubscribe();
```

Convenience subscribers for the two operator-facing event types:

```ts
agent.onAskUser((event) => {
  // event.toolCallId, event.question, event.options, event.selectionType
  showAskBanner(event);
});

agent.onDecision((event) => {
  // event.toolCallId, event.toolName, event.args, event.reason
  showDecisionPrompt(event);
});
```

### Responding to asks + decisions

```ts
// The operator's free-text reply to `message(type=ask)`:
agent.respondToAsk(toolCallId, {
  content: "yes, the second option",
  attachments: [],
});

// The operator's y/n/a verdict on a safety-policy decision:
agent.respondToDecision(toolCallId, {
  kind: "allow",   // | "deny" | "allow_and_remember"
});
```

If a frontend reconnects mid-conversation (page refresh during an
ask), it can pull the live registry to restore the UI:

```ts
const asks = agent.pendingAsks();
// [{toolCallId, taskId, question, options?, selectionType?, ts}, ...]

const decisions = agent.pendingDecisions();
// [{toolCallId, taskId}, ...]
```

### Scrubber / expander (redacting secrets in transit)

For hosts with secret-redaction needs (the huko CLI scrubs outbound
content, expands placeholders before tool execution):

```ts
const agent = engine.createAgent({
  name: "...",
  sessionId,
  scrubText: async (text) => scrubAndRecord(text, { ... }),
  expandArgs: async (value) => expandPlaceholdersDeep(value, { ... }),
});
```

The agent threads both into its cached `SessionContext` so every
persisted entry is scrubbed on write and every tool-arg value is
expanded before the handler runs.

---

## Host hooks

Cross-cutting concerns the engine consults — install through the
constructor instead of monkey-patching. **All four are optional**:
omit any of them to take the default (or the no-op equivalent).

```ts
const engine = await createHukoEngine({
  persistence,
  hostHooks: {
    // Engine-eligible config slice (safety rules, llm timeouts,
    // compaction thresholds, ...). Pipeline + tool code read it
    // via `ctx.engine.config` per-instance. Omit → DEFAULT_ENGINE_CONFIG.
    config: projectEngineConfig(hostConfig),

    // Working-directory fallback for tools (bash/glob/grep/...) when
    // neither call args nor TaskContext.cwd supplies one. Engine code
    // never reads `process.cwd()` itself. Omit → defaults to ".".
    defaultCwd: process.cwd(),

    // Safety policy invokes this when the operator picks "always
    // allow" on a tool decision — typically writes back to the host's
    // config files. Persistence failures are non-fatal. Omit → no
    // persistence (the tool still runs, the rule just isn't durable).
    safetyRulePersister: (scope, cwd, toolName, bucket, pattern) => {
      appendRule(scope, cwd, toolName, bucket, pattern);
    },

    // Plan tool invokes this when an agent's phase tags a capability.
    // Omit → `defaultBestPracticesProvider` (auto-installed; built-in
    // 4 capabilities). Pass `null` to opt out entirely. Pass your
    // own function to override (see "Built-in best practices" below
    // for the building blocks).
    // bestPracticesProvider: defaultBestPracticesProvider,  // implicit
  },
});
```

The four `hostHooks` fields live as **per-engine state** —
`ctx.engine.{config,defaultCwd,safetyRulePersister,bestPracticesProvider}`
inside pipeline / tool code. Two engines in one process can have
different config / safety persister / best-practices provider without
overwriting each other.

(The engine constructor also installs the same values into
module-level globals for back-compat with transitional callsites
that build a `TaskContext` without an engine handle. New code paths
always read the per-instance state; the globals will go away once
every transitional callsite migrates.)

### Built-in best practices (auto-installed by default)

Engine bundles four foundational capabilities — `coding`, `writing`,
`research`, `analysis` — as the in-memory `BUILT_IN_BEST_PRACTICES`
map and installs the matching `defaultBestPracticesProvider`
automatically.

When the LLM tags a plan phase with `capabilities: ["coding"]`, the
plan tool's `tool_result` grows a per-phase Expert Checklist block
pulled from the bundled markdown. No wiring required:

```ts
const engine = await createHukoEngine({ persistence });
// plan(phases=[{ ..., capabilities: ["coding"] }]) → checklist auto-attached
```

Override or opt out:

```ts
// Override with your own provider (e.g. filesystem layers on top):
const engine = await createHukoEngine({
  persistence,
  hostHooks: { bestPracticesProvider: myProvider },
});

// Opt out entirely:
const engine = await createHukoEngine({
  persistence,
  hostHooks: { bestPracticesProvider: null },
});
```

For hosts that want richer behaviour (project-local override files,
remote registries, multi-tenant rules), compose with the building
blocks:

| Export | What it does |
|--------|-------------|
| `BUILT_IN_BEST_PRACTICES` | Read-only `Record<name, rawMarkdown>` — the four bundled blobs |
| `extractBestPracticesSection(body)` | Pure section extractor — pulls `## Best Practices` block from a body |
| `resolveBestPracticeBody(raw, max?)` | Strip frontmatter → prefer section → cap → return body or null |
| `resolveBuiltInBestPractice(name, max?)` | Same pipeline, sourced from the bundled map |
| `formatBestPracticesInjection(phaseId, title, entries)` | Canonical header + per-capability blocks; returns the final string |
| `defaultBestPracticesProvider` | Ready-to-use `BestPracticesProvider` walking the bundled map only (the one installed by default) |

The [huko-cli](https://github.com/alexzhaosheng/huko) repo's
`packages/huko-cli/src/task/best-practices.ts` is a worked example
of wrapping the engine helpers with project + user filesystem
override layers (~50 lines total).

---

## Multiple agents in one process

Two genuinely different agents, sharing the same engine:

```ts
const engine = await createHukoEngine({ persistence });

const systemChatId = await engine.createSession({ title: "System chat" });
const systemAgent = engine.createAgent({
  name: "system-chat",
  sessionId: systemChatId,
  defaultProvider,
  overlays: [{ name: "system-role", content: "...", position: "tail" }],
  tools: { allow: ["bash"] },
});

const buildAgentId = await engine.createSession({ title: "Build agent" });
const buildAgent = engine.createAgent({
  name: "build-agent",
  sessionId: buildAgentId,
  defaultProvider,
  cwd: "/path/to/app",
  overlays: [{ name: "build-context", content: "...", position: "tail" }],
  tools: { allow: ["bash", "edit_file", "write_definition_file"] },
});
```

Both share the engine's tool registry + persistence + host hooks.
Each agent's `SessionContext`, live task, ask/decision registries,
and event subscribers are isolated.

---

## Package boundary

Engine code under `src/` must not depend on a specific host
environment. That means no:

- HTTP, Socket.IO, or other transport (host wires those)
- Concrete persistence backends — engine sees only the
  `AgentPersistence` / `SessionPersistence` interfaces, not their
  implementations
- `process.cwd()` — host injects `defaultCwd` via hostHooks instead
- DOM, drizzle, or other dep that ties the engine to one runtime

Enforced two ways:

1. **Package-level**: anything the engine imports must be a `node:*`
   builtin, a dep declared in this package's `package.json`, or a
   sibling file inside `src/`. pnpm's per-package install rejects
   undeclared imports at install time; Node's resolver rejects them
   at runtime.
2. **`tests/engine-boundary.test.ts`** in the cli package walks
   engine sources and greps imports as a belt-and-braces check.

---

## Layout

```text
src/
├── facade.ts                    createHukoEngine + HukoEngine + HukoAgent
├── SessionContext.ts            @internal — session-scoped data bus
├── TaskContext.ts               @internal — task-scoped runtime state
├── config/                      EngineConfig + module-level state
├── features/                    feature registry + sidecar lifecycle
├── llm/                         provider abstraction: protocols, openai
│                                adapter, types, model context window,
│                                raw-debug-log, cache-boundary sentinel
├── persistence/
│   ├── agent-persistence.ts     narrow interface
│   ├── sqlite.ts                SqliteAgentPersistence
│   ├── memory.ts                MemoryAgentPersistence
│   └── types.ts                 wider SessionPersistence (host-side)
├── prompt/
│   ├── assemble.ts              @internal — canonical assembler
│   ├── lean.ts                  @internal — lean profile composer
│   ├── blocks.ts                named building blocks
│   └── overlay.ts               PromptOverlay type + position bucketing
├── safety/                      pure policy evaluator
├── skills/                      skill parsing primitives (file IO host-side)
├── task/                        task execution: task-loop.ts, pipeline/,
│                                behavior-guard, language-reminder,
│                                plan-state, resume, task-boundary,
│                                tools/ (foundational implementations +
│                                registry)
├── util/yaml-frontmatter.ts     zero-dep YAML subset parser
├── shared/                      type-only modules (events, llm-protocol,
│                                plan-types, types)
└── index.ts                     public barrel — facade + persistence +
                                 overlay + event/protocol types
```

---

## Internal kernel

The engine kernel primitives (`TaskLoop`, `TaskContext`,
`SessionContext`, `assembleSystemPrompt`, `assembleLeanSystemPrompt`,
`recoverOrphans`, `registerServerTool`) are tagged `@internal` in
JSDoc. They remain exported via subpath imports for engine tests +
pre-facade host paths, but new host code should reach for the public
facade barrel instead.

`@internal` is a documentation tag, not a runtime check — imports
still work. The tag signals that the surface is engine-internal and
may shift between releases without a deprecation cycle.

---

## See also

- **[huko-cli](https://github.com/alexzhaosheng/huko)** —
  reference host implementation. The cli daemon, web UI, CLI
  formatters, scheduler, scrubber, browser tool, file-share tool,
  and the orchestrator wiring around `engine.startTurn` /
  `agent.respondToAsk` are all worth reading if you're embedding
  the engine into a daemon-style product.
- **[docs/public-api-facade.md](docs/public-api-facade.md)** —
  why the facade looks like this, the design tradeoffs, and the
  migration steps the engine went through to reach this shape.
- **[docs/RELEASE.md](docs/RELEASE.md)** — release process for
  this package (tag-triggered npm publish with provenance).

---

## Status

Published as `@alexzhaosheng/huko-engine` on npm. Versioned per
semver:

- `0.x` — public API may still shift. Pinning to an exact patch is
  reasonable until 1.0.
- breaking changes within `0.x` get called out explicitly in the
  CHANGELOG; bumps to the minor version.

Release process is documented in [`docs/RELEASE.md`](docs/RELEASE.md)
— tag-triggered, no manual `npm publish` from a laptop.

CI runs on every push and PR across Linux / macOS / Windows × Node
24 (see `.github/workflows/ci.yml`).

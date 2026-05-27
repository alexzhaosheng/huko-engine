# huko-engine CLAUDE.md

Rules for `@alexzhaosheng/huko-engine` — the standalone npm package
extracted from the original huko monorepo.

For repo / release plumbing, see [`docs/RELEASE.md`](docs/RELEASE.md).
For design rationale on the public facade, see
[`docs/public-api-facade.md`](docs/public-api-facade.md).

---

## 1. Scope

`huko-engine` is the shared agent kernel. It owns:

- session and task runtime primitives;
- LLM protocol adapters and invocation;
- task loop and pipeline;
- tool registry primitives and foundational tool implementations;
- safety policy evaluation;
- skill parsing primitives;
- prompt assembly primitives;
- persistence interfaces and shared protocol types.

It must stay embeddable by any Node host. The reference host integration
is `huko-cli`; the facade must not lock in CLI-specific assumptions.

---

## 2. Dependency boundary

Engine code must not import host infrastructure:

- no HTTP, Express, Socket.IO, or tRPC;
- no concrete database clients such as drizzle or better-sqlite3
  (the bundled `SqliteAgentPersistence` uses better-sqlite3 only because
  it lives inside the engine package and ships as one of the persistence
  options);
- no DOM, React, browser globals, or frontend code;
- no CLI command parsing or config-file layout assumptions;
- no host-product-specific runtime assumptions.

Engine code may import:

- Node builtins;
- dependencies declared by the engine package;
- other engine source files.

If engine code needs host state or IO, define a narrow interface or callback and
let the host inject it.

Do not call `process.cwd()` from engine code. Accept cwd or working-directory
values from the host.

---

## 3. Public contracts

### Public facade (what new host code should reach for)

The recommended entry point is the package barrel:

```ts
import {
  createHukoEngine,
  HukoEngine,
  HukoAgent,
  SqliteAgentPersistence,
  MemoryAgentPersistence,
  type AgentPersistence,
  type Provider,
  type PromptOverlay,
  type StartTurnInput,
  type TaskHandle,
  type AgentTurnResult,
  type HukoEvent,
  type Emitter,
} from "@alexzhaosheng/huko-engine";
```

The facade owns:

- Engine lifecycle (per-instance tool registry, host hooks, persistence).
- Agent lifecycle (session-pinned, SessionContext cache, ask/decision
  registries, event subscribers, mid-flight `stop()` / `liveTaskId()` /
  `interject` control).
- System-prompt assembly (canonical block order, overlays, scheduled-task
  block, lean vs full profile).
- Task spinup + completion bookkeeping (atomic create-task + initial entry
  when persistence supports it, error-path persistence, task-row write-back).

If new host code is reaching for something below the facade, that's usually a
gap in the facade — file it as a future round rather than papering over it
with a deeper import.

### Kernel primitives (`src/internal/`)

These live physically under `src/internal/` AND get dropped from
`publishConfig.exports` so external npm consumers can't reach them. In
workspace / dev mode they're still importable via subpath
(`@alexzhaosheng/huko-engine/internal/X.js`) for cli + tests; the
restriction kicks in at publish time.

- `internal/SessionContext.ts` — session-scoped data bus. The facade
  caches one per agent and forwards events to its subscribers.
- `internal/TaskContext.ts` — per-task runtime state + injected host
  capability. The facade builds this from `StartTurnInput` + agent
  options. Carries `engine?: EngineHandle` so pipeline / tool code
  reads per-instance config / cwd / hooks without touching globals.
- `internal/task-loop.ts` — the LLM/tool/result loop. The facade owns
  lifecycle, ask/decision wiring, interjection, stop semantics —
  hand-wiring TaskLoop loses all of that.
- `internal/prompt/assemble.ts` / `internal/prompt/lean.ts` — system-
  prompt composers the facade selects on `profile`.
- `internal/resume.ts` — orphan-recovery for daemon-style hosts.
  Relies on the richer `SessionPersistence` shape, not the facade's
  narrow `AgentPersistence`; cli's `TaskOrchestrator.recoverOrphans`
  wraps it.

Also marked `@internal` (lives where it always has, for back-compat):
- `registerServerTool` in `task/tools/registry.ts` — process-global
  registration the engine's foundational tools use. New hosts call
  `engine.registerTool({...})` per-instance, or
  `registerFoundationalTools(engine)` for the bundled 13 at once.

### Other engine surface

- `HukoEvent` is the semantic kernel-to-frontend protocol. Stable.
- `AgentPersistence` is the narrow persistence contract the facade
  consumes; `SessionPersistence` (richer, host-owned) wraps or adapts down
  to it. New host code implements `AgentPersistence` directly or uses
  cli's `agentPersistenceFromSession` projector.
- Tool execution still flows through the registry + `tool-execute`
  pipeline so coercion, safety, persistence, and reminders remain
  centralized.

Do not bypass any of these seams from new code.

---

## 4. Tool and feature rules

Engine foundational tools should export definitions and handlers. Hosts choose
their tool surface by importing and registering them.

Tool descriptions are part of the LLM-facing API. Keep them precise, typed, and
stable. Prefer adding semantic metadata or a narrow new tool over teaching the
model to infer hidden behavior.

If a new tool has side effects, set an appropriate `dangerLevel` and make sure
the safety policy can gate it.

---

## 5. Prompt rules

Prompt assembly in engine must stay pure. Engine can render prompt blocks from
resolved data, but it must not read files, discover skills, inspect project
state, or know host-specific overlays.

Host packages collect IO-backed context and pass it into engine prompt builders.

---

## 6. Compatibility rule

Every engine API change must:

- update or preserve current `huko-cli` behavior;
- keep the shape general enough for arbitrary embedding hosts;
- avoid adding CLI-specific or host-specific concepts to engine types
  unless they are truly kernel concepts.

---

## 7. Verification

Run the engine package checker after engine changes:

```bash
pnpm --filter @alexzhaosheng/huko-engine run check
```

If `pnpm` is unavailable in the current shell, use the package `tsconfig` with
the available Node/TypeScript runtime.

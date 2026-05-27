# AGENTS.md

Guidance for AI assistants helping a developer integrate
`@alexzhaosheng/huko-engine` into their project.

(For contributors editing this engine itself, see
[`CLAUDE.md`](CLAUDE.md) — it covers internal rules. AGENTS.md is
for *consumers*.)

---

## What this package is

An embeddable agent runtime: LLM protocol adapters, task loop, tool
framework, safety policy, skill loader, prompt assembler, persistence.
Hosts call into a small facade (`createHukoEngine` + `HukoAgent`) and
the engine drives the loop. ESM-only, Node 20+.

## Rules to follow

1. **Use the facade root only.** Import from
   `@alexzhaosheng/huko-engine`, never from a subpath
   (`@alexzhaosheng/huko-engine/foo/bar.js`). The exports map blocks
   subpaths at install time; if a host needs something not at the
   root, it belongs on the root and isn't there yet — open an issue
   in the engine repo rather than reaching past the boundary.

2. **Build the engine with `createHukoEngine` (async)**, not
   `new HukoEngine(...)`. The factory runs the orphan-recovery scan
   that production hosts need.
   - `createHukoEngineSync` exists for tests / scripts using
     `MemoryAgentPersistence` (no recovery to scan for).

3. **Tools require allow-listing.** `HukoAgent.options.tools.allow`
   is the only way a tool reaches the LLM. Without it, the agent
   has zero tools — including the 13 foundational tools that the
   engine auto-registers on construction.

4. **Persistence is required.** Pass one to `createHukoEngine`.
   The bundled choices:
   - `MemoryAgentPersistence` — ephemeral, fine for examples / tests
   - `SqliteAgentPersistence(path)` — local file, schema applied
     lazily, orphan recovery scans this DB on next boot

5. **Host tools register per-engine.** Don't push host concerns into
   the engine package. Define `ServerToolDefinition` + handler in
   your host code, then `engine.registerTool({ ...def, handler })`.

6. **Streaming events go through `agent.onEvent(handler)`.** Returns
   an unsubscribe function. Subscribe BEFORE `startTurn` / `runTurn`
   so the `assistant_started` event isn't missed.

## Where to look for code patterns

- [`example/cli-chat/`](example/cli-chat/) — smallest end-to-end
  agent (~75 lines)
- [`example/with-sqlite/`](example/with-sqlite/) — persistent variant
- [`example/custom-tool/`](example/custom-tool/) — host adds its own
  tool (the engine.registerTool pattern)
- [`example/web-server/`](example/web-server/) — Node http + SSE,
  streaming events to a browser

For a real-world host integration, see
[huko-cli](https://github.com/alexzhaosheng/huko) — daemon, web UI,
scheduler, file-share. The maximal example.

## Where to look for reference docs

- [`README.md`](README.md) — quick start, the defaults, host
  hook tour
- [`docs/public-api-facade.md`](docs/public-api-facade.md) — why the
  facade looks like this; design tradeoffs
- [`docs/cookbook.md`](docs/cookbook.md) — copy-pasteable recipes
  for common patterns
- `.d.ts` files under `node_modules/@alexzhaosheng/huko-engine/dist/`
  after install — full type surface for hover / autocomplete

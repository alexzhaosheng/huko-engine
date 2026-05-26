# example/cli-chat

The smallest end-to-end huko-engine demo: a terminal chat agent with
every default tool turned on. ~55 lines of TypeScript.

## What it shows

- `createHukoEngine` + `MemoryAgentPersistence`
- `engine.createAgent` with the foundational tool surface allow-listed
- Streamed output via `agent.onEvent`
- One turn = one `agent.runTurn({ message })`

## Run

```bash
OPENROUTER_API_KEY=sk-or-... npx tsx example/cli-chat/main.ts
```

Default model: `deepseek/deepseek-v4-pro`. Override with
`MODEL=<openrouter-slug>` for anything OpenRouter serves.

Blank input (or Ctrl+D) quits. Conversation state lives in memory —
closing the process forgets everything.

## Customise

- **Narrower toolset**: drop names from the `tools.allow` list in
  `main.ts`, or replace with a hand-picked subset like
  `["read_file", "edit_file", "bash"]` for a coding-only agent.
- **Persist across runs**: swap `MemoryAgentPersistence` for
  `SqliteAgentPersistence(path)`.
- **Inject best-practices**: pass `hostHooks.bestPracticesProvider`
  to `createHukoEngine` to override the default checklist. Default =
  `defaultBestPracticesProvider` (engine's built-in four roles).

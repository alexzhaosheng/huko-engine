# example/cli-chat

The smallest end-to-end huko-engine demo: a terminal chat agent with
every default tool turned on. ~55 lines of TypeScript.

## What it shows

- `createHukoEngine` + `MemoryAgentPersistence`
- `engine.createAgent` with the foundational tool surface allow-listed
- Streamed output via `agent.onEvent`
- One turn = one `agent.runTurn({ message })`

## Run

From the engine repo root (the directory with `package.json`), after
`npm install`:

```bash
OPENROUTER_API_KEY=sk-or-... npm run example:cli-chat
```

The npm script handles the relative paths inside `main.ts`; running
`npx tsx example/cli-chat/main.ts` from inside the `example/cli-chat/`
directory fails with `ERR_MODULE_NOT_FOUND` because tsx resolves the
entry path relative to cwd.

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

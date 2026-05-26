# example/cli-chat

The smallest end-to-end huko-engine demo: a terminal chat agent with
every default tool turned on. About 70 lines of TypeScript.

## What it shows

- `createHukoEngine` with in-memory persistence
- `HukoAgent` with the bundled foundational tool surface auto-registered
- One turn = one `agent.runTurn({ message })` call
- Streaming output via `agent.onEvent` (assistant deltas + tool calls + tool results)

## Run

```bash
# Use any OpenRouter key (default endpoint).
OPENROUTER_API_KEY=sk-or-... npx tsx example/cli-chat/main.ts
```

```bash
# Or any OpenAI-protocol endpoint.
OPENAI_BASE_URL=https://api.openai.com/v1 \
OPENAI_API_KEY=sk-... \
MODEL=gpt-4o-mini \
  npx tsx example/cli-chat/main.ts
```

Type a message, hit enter. Blank input (or Ctrl+D) quits. Conversation
state lives in memory only — closing the process forgets everything.

## Customise

- **Pick a different model**: `MODEL=anthropic/claude-sonnet-4.5`
- **Narrower toolset**: replace the `tools.allow` list in `main.ts`
  with a hand-picked subset of foundational tool names, e.g.
  `["read_file", "edit_file", "bash"]` for a coding-only agent.
- **Persist across runs**: swap `MemoryAgentPersistence` for
  `SqliteAgentPersistence(path)` — same interface; engine handles
  the rest.
- **Inject best-practices**: pass `hostHooks.bestPracticesProvider`
  to `createHukoEngine` to customise the role-flavoured tool_result
  the `plan` tool surfaces. Default = `defaultBestPracticesProvider`
  (engine's built-in four roles).

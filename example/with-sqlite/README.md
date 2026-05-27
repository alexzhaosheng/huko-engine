# example/with-sqlite

Same chat loop as [`cli-chat/`](../cli-chat/), but with persistence on
disk. Engine handles schema, orphan recovery, and entry writes; the
only line that changes is the persistence factory.

## Run

```bash
OPENROUTER_API_KEY=sk-or-... npm run example:with-sqlite
```

DB defaults to `./agent.db` (gitignore it). Override with
`DB_PATH=path/to/agent.db`.

Run twice. The second boot prints how many sessions are already in the
db before starting a fresh one alongside.

## What you can do with the db handle

`SqliteAgentPersistence.db` is a public read/write `better-sqlite3`
handle. Engine's narrow `AgentPersistence` interface doesn't expose
session lists / search / paging — those are host concerns. Both cli
and app-studio build richer query surfaces on top of the same handle.
The `priorCount` lookup in `main.ts` is the smallest example.

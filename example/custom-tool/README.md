# example/custom-tool

How the host adds its own tool. Same pattern app-studio uses for
`write_definition_file` and huko-cli uses for `browser` /
`share_file`.

## What it shows

- A tiny in-memory `todo` tool — add / list / done
- `engine.registerTool({...definition, handler})` for per-engine
  registration (foundational tools auto-register; host tools are
  explicit)
- The agent's `tools.allow` includes both the new tool and the
  foundational ones it should also see

## The three pieces

1. **Definition** (`ServerToolDefinition`) — `name`, `description`,
   JSON-Schema `parameters`, optional `dangerLevel`.
2. **Handler** (`ServerToolHandler`) — `(args, ctx, callMeta) =>
   string | ServerToolResult | ToolHandlerResult`. Sync or async.
3. **Registration** — `engine.registerTool({ ...definition, handler })`.

## Run

```bash
OPENROUTER_API_KEY=sk-or-... npm run example:custom-tool
```

Try prompts like *"add three things: milk, dog, report. then list
them. then mark the first done."*

## Going further

- The handler's `ctx: TaskContext` argument exposes the working
  directory, the current task / session id, an emit helper, and a
  policy-aware logger. See `src/internal/TaskContext.ts` for the
  shape (publicly exported as a type from the facade root).
- Returning `{ content: "", error: "..." }` surfaces a tool-level
  error to the LLM (the engine will retry / replan as appropriate).
- Returning `{ content, finalResult, shouldBreak: true }` ends the
  task with `finalResult` (the `message` tool's `type=result` works
  this way).
- For interactive tools that need to wait on the operator, look at
  `respondToAsk` / the `ask_user` event.

# Tools

> `src/task/tools/` defines tool registration, runtime argument coercion, tool policy metadata, and built-in tools.


## Files

```text
src/task/tools/
  registry.ts            dual registration, ToolHandlerResult, coercion
  index.ts               side-effect imports for built-in tools
  server/
    bash.ts              persistent shell session
    plan.ts              update / advance planning
    message.ts           single user-facing speech channel
    share-file.ts        hand a file from cwd to the user without leaking content
    read-file.ts         read a text file (with line numbers)
    write-file.ts        atomic write + two-layer verify
    edit-file.ts         atomic find-and-replace with fuzzy whitespace
    delete-file.ts       remove a single file (refuses dirs)
    move-file.ts         move / rename file or directory
    glob.ts              find files by glob pattern
    grep.ts              search file contents by regex
    list-dir.ts          one line per entry
    web-fetch.ts         HTTP GET (text or html)
    web-search.ts        engine query → ranked results
    browser.ts           drive the user's real Chrome (browser-control feature)
    browser-session.ts   WebSocket sidecar (infrastructure — not LLM-facing)
    _atomic-write.ts     internal helper
    _write-verify.ts     internal helper
  workstation/           future workstation-routed tools
```

## Two Registration Entry Points

Server tools run in the Node process:

```ts
registerServerTool(definition, async (args, ctx) => {
  return "result";
});
```

Workstation tools are routed to the user's local machine:

```ts
registerWorkstationTool(definition);
```

The two functions are mutually exclusive. Registering the same tool name twice throws. Workstation tools do not have in-process handlers; execution goes through the injected `ctx.executeTool` callback.

## Why Not One `registerTool` Flag

Separate functions make the dispatch path visible in the code and type system:

- Server tools must provide a handler.
- Workstation tools must not provide a handler.
- Tool authors choose the execution location when writing the tool file.

## `ToolHandlerResult`

Server tool handlers can return three shapes, from simplest to richest:

```ts
// 1. Simple string: directly used as tool result content
return "done";

// 2. Legacy/simple result object
return { result: "done", error: null };

// 3. Rich semantic result
return {
  content: "LLM-visible result",
  finalResult: "user-visible final answer",
  shouldBreak: true,
  summary: "short UI summary",
  attachments: [],
  metadata: { ... },
  error: null,
};
```

`shouldBreak` means that after the current tool result is persisted, `TaskLoop` exits cleanly with status `done`. No extra LLM call is made, and deferred calls from the same turn are discarded.

`finalResult` writes to `ctx.finalResult` and marks that the task has an explicit result. It is commonly paired with `shouldBreak`, though future agent-style subtasks may set it without ending the parent loop.

`metadata` is preserved on the persisted `tool_result` entry and read by frontends (the web UI uses it to render message tool replies, attachment chips, etc.). Don't put presentation formatting in `content` — that string is for the LLM; UI consumers read `metadata`.

## Argument Coercion

LLMs sometimes return `"true"` for booleans, JSON strings for arrays/objects, or numeric strings such as `"5"`. `tool-execute.ts` calls `coerceArgs(name, args)` before dispatch.

| Schema type | Accepted input |
|---|---|
| boolean | booleans and strings such as `"true"`, `"false"`, `"1"`, `"0"`, `"yes"`, `"no"` |
| number | numbers and parseable strings |
| string | any primitive converted with `String(...)` |
| array | arrays or JSON array strings |
| object | objects or JSON object strings |

Unknown fields pass through unchanged. Missing required fields are not invented; the tool should report a clear error.

## Platform Notes

Server tools may attach platform-specific notes to the model-visible description. `getToolsForLLM` materializes only the note for the current platform, so other platform notes are not exposed.

## Policy Metadata

`registerServerTool` and `registerWorkstationTool` accept a `dangerLevel`:

| Level | What it means | Tools |
|---|---|---|
| `safe` | Idempotent, no side effects | `read_file`, `list_dir`, `glob`, `grep`, `web_fetch`, `web_search`, `share_file`, `plan`, `message` |
| `moderate` | Recoverable side effect (overwrite a known file, navigate a tab) | `write_file`, `edit_file`, `move_file`, `browser` |
| `dangerous` | Irreversible if invoked carelessly | `bash`, `delete_file` |

The safety subsystem (huko-cli safety subsystem) layers operator-defined rules on top: per-tool `disabled` removes a tool from the LLM surface entirely; `deny` / `allow` / `requireConfirm` regex patterns gate specific call shapes. See [config.md](./config.md) for the safety rule format.

`feature: <name>` ties a tool to a feature bundle so one operator decision toggles all of its tools at once (see [features.md](./features.md)). `browser` is feature-tagged; the rest are unconditional.

## Self-Registration Flow

Each built-in tool file calls `registerServerTool(...)` or `registerWorkstationTool(...)` at module load time. `tools/index.ts` imports all built-in tool files for side effects.

To add a tool:

1. Create a tool file under the appropriate folder.
2. Register it at top level.
3. Add a side-effect import to `tools/index.ts`.
4. Add focused tests.

## Filtering

`getToolsForLLM(filter)` projects the global registry into the current task's visible tool list. The filter respects:

- `interactive: false` — strips `ask` from `message`'s type enum so non-interactive runs can't ask for input
- `lean: true` — render each surviving tool via its `leanDescription` (shorter blurbs)
- `allowedTools: string[]` — whitelist mode used by `--lean` (forces `bash`-only surface)
- feature gating — disabled features' tools vanish
- safety gating — `disabled` tools vanish

The registry stays global; visibility is per call.

## Built-In Server Tools

Listed in the order an operator typically reasons about them — speech first, planning next, then file ops, shell, web, browser.

### Messaging

#### `message`

The single user-facing speech channel. Three modes:

- `info` — progress / acknowledgement; loop continues
- `ask` — blocks until the user replies; reply text becomes the tool result (stripped in non-interactive runs)
- `result` — final deliverable; sets `ctx.finalResult` and ends the task

Use `result` even for trivial replies — plain assistant text without a tool call earns a corrective `system_reminder`. The web UI reads `metadata.messageType` + `metadata.text` to render the message; `content` (`"Message sent to user."`) is just an LLM-side placeholder.

#### `share_file`

Hands a file from inside `<cwd>` back to the user without exposing its contents to the LLM. The handler registers the file with huko-cli file-share service, returns a one-time download token, and the web UI surfaces a download chip. CLI runs print the path. Useful for "generate this binary" or "extract this PDF" flows — the agent never reads what it produced.

### Planning

#### `plan`

Two actions:

- `update` — replace the entire plan with a fresh list of phases (`title`, `goal`, `capabilities?`, `status`). Each phase's `capabilities` selects a domain expertise pack (`coding`, `writing`, `research`, `analysis`) — the matching checklist is spliced into the tool result on phase activation.
- `advance` — mark the current phase done and activate the next.

Plan state lives on `TaskContext.planState`. Plans drive both the UI (the operator sees a checklist) and the agent's working context (the active phase + its expert checklist appears in the system reminder loop).

Trivial tasks should not use `plan` — they go straight to `message(type=result)`. Substantive multi-step work should always plan first.

### Filesystem (read)

#### `read_file`

Read a text file's contents. Returns the body with **line numbers prefixed** (`cat -n` shape) so the LLM can refer to specific lines when calling `edit_file`. Refuses files above a size cap (use `bash` + `head`/`tail` for huge files).

Args: `path` (relative to `cwd` or absolute).

#### `list_dir`

List the entries of a directory, one line per entry with type + size. Cheap default for "what's in this folder" before deciding to grep or read individual files. Args: `path`.

#### `glob`

Find files matching a glob pattern. Returns absolute paths sorted by modification time (newest first). Use this instead of `bash 'find ...'` when the pattern is simple — it's faster and the output is consistently formatted. Args: `pattern`, optional `cwd`.

#### `grep`

Search file contents for a regex. Pure JS (no ripgrep dep). Returns matches with file + line + column. Args: `pattern`, optional `path` (file or directory), optional `glob` (further restrict scope), optional `outputMode` (`content` / `files_with_matches`).

### Filesystem (write)

`dangerLevel: moderate` — recoverable but visible side effect.

#### `write_file`

Overwrite (or create) a text file with new content. Auto-creates parent directories. Uses **atomic write** (temp file + rename) and **two-layer verify** (re-read after write, byte-compare; fall back to fsync probe on mismatch) — the LLM never sees a half-written file. Args: `path`, `content`.

#### `edit_file`

Atomic find-and-replace edits with whitespace-tolerant fuzzy matching. Refuses if the `old_string` isn't unique in the file (caller must widen the surrounding context until uniqueness is unambiguous). Same atomic write + verify as `write_file`. Args: `path`, `old_string`, `new_string`, optional `replace_all`.

Prefer `edit_file` over `write_file` for modifying existing files — the diff is surgical and unrelated content is provably untouched.

#### `move_file`

Move or rename a file or directory. Refuses to clobber an existing destination unless `overwrite: true`. Args: `from`, `to`.

### Shell

#### `bash`

`dangerLevel: dangerous`. Execute shell commands in a **persistent session** — environment variables, working directory, and shell state survive between calls within one task. Captures stdout + stderr + exit code; truncates output at a size cap. Args: `command`, optional `timeoutMs`, optional `cwd`.

The persistence is intentional: a multi-step shell flow (`cd src/`, `./build.sh`, `cd ../bin/`, `./run`) works without re-establishing the cwd each call.

For `--lean` mode this is the **only** tool exposed.

### Filesystem (destructive)

#### `delete_file`

`dangerLevel: dangerous`. Remove a single file from disk. Refuses directories by default (use `bash rm -r` for trees, where the operator's safety policy can require confirmation). Args: `path`.

### Web

#### `web_fetch`

HTTP GET for one URL. Args: `url`, optional `mode: "text" | "html"`.

- `text` mode strips scripts, styles, and tags, then decodes common entities — usually what you want
- `html` mode returns raw HTML — for the LLM to parse structure itself

Enforces size + timeout limits. GET only.

#### `web_search`

Run a search engine query and return ranked results (title + snippet + URL). v1 ships one backend; see source for current provider. Args: `query`, optional `limit`.

Pair with `web_fetch` to follow links the search surfaces.

### Browser (feature-gated)

Disabled by default; enable with `huko --enable=browser-control` or in config. Requires the Chrome extension. See [features.md](./features.md) for the bundle mechanism and `README.md` § Browser Control for end-to-end setup.

#### `browser`

`dangerLevel: moderate`. Operate the user's real Chrome browser through the extension — same cookies, sessions, and logins as what the user sees. One action per call: `navigate`, `click`, `fill`, `screenshot`, `eval`, etc.

The `browser-session.ts` file in the same directory hosts the WebSocket server the extension connects to; it's **not** a registered tool, just the sidecar infrastructure.

## Pitfalls

- Do not register tools from routers or handlers; registration timing becomes unpredictable.
- Do not register the same tool name twice (collides with feature names too — see [features.md](./features.md)).
- Do not block the Node event loop with heavy synchronous CPU work in server tool handlers.
- Do not call `sessionContext.append` directly from a handler; `tool-execute.ts` writes the tool result.
- Do not put presentation strings in `content` — that's the LLM's view. UI-side rendering reads `metadata`.

## Verification

```bash
npm run check
npm test
```

## See Also

- [pipeline.md](./pipeline.md)
- [llm.md](./llm.md)
- [task-loop.md](./task-loop.md)
- [features.md](./features.md) — how `browser` is feature-gated
- [config.md](./config.md) — safety rule format for `disabled` / `deny` / `allow` / `requireConfirm`

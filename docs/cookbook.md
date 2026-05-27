# Cookbook

Copy-pasteable recipes for common huko-engine patterns. Each starts
from the facade root — no subpath imports.

Companions:

- [README](../README.md) — quick start + facade tour
- [example/](../example/) — runnable end-to-end demos for the main
  shapes (CLI chat, sqlite, custom tool, web server)

---

## Switch provider

`Provider` is a plain struct. Swap fields to switch backend.

```ts
// OpenAI direct
const openai: Provider = {
  protocol: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  modelId: "gpt-4o",
  toolCallMode: "native",
  thinkLevel: "off",
  contextWindow: 128_000,
};

// OpenRouter (any model behind one key)
const openrouter: Provider = {
  protocol: "openai",          // same protocol — openrouter is OpenAI-compatible
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
  modelId: "anthropic/claude-sonnet-4.5",
  toolCallMode: "native",
  thinkLevel: "off",
  contextWindow: 200_000,
};

// Anthropic-flavoured tool calling (still OpenAI-shaped wire protocol):
const anthropicShim: Provider = {
  protocol: "openai",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY!,
  modelId: "anthropic/claude-opus-4.7",
  toolCallMode: "native",
  thinkLevel: "high",          // engine drives Anthropic's extended thinking
  contextWindow: 200_000,
};
```

Override per-turn via `agent.runTurn({ message, provider: openai })`
if you want a single agent to multiplex across providers.

---

## Persist conversations to disk

```ts
import { createHukoEngine, SqliteAgentPersistence } from "@alexzhaosheng/huko-engine";

const engine = await createHukoEngine({
  persistence: new SqliteAgentPersistence("./agent.db"),
});
```

That's it — schema is applied lazily, orphan recovery scans this same
DB on next boot. The raw `better-sqlite3` handle is exposed as
`persistence.db` if you need host-side queries (session listing,
search) that the engine's narrow interface doesn't cover. See
[`example/with-sqlite/`](../example/with-sqlite/).

---

## Register a host tool

```ts
import type { ServerToolDefinition, ServerToolHandler } from "@alexzhaosheng/huko-engine";

const myToolDef: ServerToolDefinition = {
  name: "fetch_metric",
  description: "Read a Prometheus metric value.",
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  dangerLevel: "safe",
};

const myToolHandler: ServerToolHandler = async (args, ctx) => {
  const value = await prometheus.query(String(args.name));
  return `${args.name} = ${value}`;
};

engine.registerTool({ ...myToolDef, handler: myToolHandler });

// Then expose it to the agent:
const agent = engine.createAgent({
  ...,
  tools: { allow: ["fetch_metric", "plan", "message"] },
});
```

The handler can return a `string`, a `{ content, error? }` object, or
a `ToolHandlerResult` for advanced cases (final-result flag, attached
artifacts, metadata for UI rendering). See
[`example/custom-tool/`](../example/custom-tool/).

---

## Limit the tool surface

```ts
const codingOnly = engine.createAgent({
  ...,
  tools: { allow: ["plan", "message", "bash", "read_file", "edit_file", "write_file", "grep", "glob", "list_dir"] },
});
```

Omit `tools` entirely for a tool-less chat. Drop names from the list
for a coding-only / research-only / writing-only agent — the LLM
literally doesn't see what isn't allowed.

`FOUNDATIONAL_TOOL_REGISTRATIONS.map(r => r.name)` gives you the full
13-tool default if you want all of them.

---

## Stream events to a network client

```ts
const unsubscribe = agent.onEvent((ev) => {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
});

try {
  await agent.runTurn({ message });
} finally {
  unsubscribe();
  res.end();
}
```

Subscribe BEFORE you start the turn. Every `HukoEvent` fans out to
every active subscriber. See [`example/web-server/`](../example/web-server/)
for a full Node http + SSE shape.

For mid-flight stop, decision routing, or attaching to an in-flight
task, use `agent.startTurn(...)` (returns a `TaskHandle`) instead of
`runTurn`. The handle's `taskId` is the key for
`engine.stopTask(taskId)` etc.

---

## Two-way operator interaction (ask/answer)

When the agent issues `message(type=ask, text=...)`, the engine
suspends the task until you respond:

```ts
agent.onAsk(async (event) => {
  // event.askId, event.question, event.options?, event.selectionType?
  const reply = await uiPromptUser(event.question, event.options);
  await agent.respondToAsk(event.askId, reply);
});
```

For non-interactive runs, build the agent with `interactive: false`
in `HukoAgentOptions` — the engine materialises the `message` tool's
schema without the `ask` enum so the LLM literally cannot request
input.

---

## Load skills from disk

```ts
import { parseFrontmatter, splitFrontmatter, type Skill } from "@alexzhaosheng/huko-engine";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function loadSkills(dir: string): Skill[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = readFileSync(path.join(dir, f), "utf8");
      const { frontmatter, body } = splitFrontmatter(raw);
      const meta = parseFrontmatter(frontmatter);
      return { name: meta.name as string, frontmatter: meta, body, source: "project" as const };
    });
}

const agent = engine.createAgent({
  ...,
  skills: loadSkills("./.huko/skills"),
});
```

The engine renders skills as `<skills>` blocks in the system prompt
between the foundational rules and project context. The `activeSkillNames`
helper picks active ones per turn if you want skill rotation.

---

## Override best-practices

By default, when the `plan` tool's phase capability is `coding` /
`writing` / `research` / `analysis`, the tool result gets an "Expert
Checklist" appended. Override with your own registry:

```ts
import type { BestPracticesProvider } from "@alexzhaosheng/huko-engine";

const myProvider: BestPracticesProvider = {
  async resolve(name) {
    if (name === "compliance") return { name, body: "<your project's compliance rules>" };
    return null;
  },
};

const engine = await createHukoEngine({
  persistence,
  hostHooks: { bestPracticesProvider: myProvider },
});
```

Pass `bestPracticesProvider: null` to disable injection entirely.
Combine with the bundled `defaultBestPracticesProvider` by wrapping it.

---

## Run on a schedule

For cron-fired headless agents — same agent, repeated invocations,
each one framed as a scheduled task in the system prompt:

```ts
import { StartTurnInput } from "@alexzhaosheng/huko-engine";

setInterval(async () => {
  await agent.runTurn({
    message: "do the morning digest",
    interactive: false,
    scheduledTask: {
      name: "morning-digest",
      cron: "0 8 * * *",
      previousFinalResult: lastResult,   // optional cross-fire continuity
    },
  });
}, 24 * 60 * 60 * 1000);
```

Engine forces `message(ask)` to fail-closed when `interactive: false`;
the agent self-decides or reports an issue via `result` for the next
fire to see.

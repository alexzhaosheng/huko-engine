/**
 * example/custom-tool — host adds its own tool.
 *
 * Shows the `engine.registerTool({...})` pattern host integrations
 * use to extend the agent's surface beyond the bundled foundational
 * tools. Same shape app-studio uses for `write_definition_file`
 * and huko-cli uses for `browser` / `share_file`.
 *
 * The example tool is a tiny in-memory todo list. The agent can
 * `todo(action="add", text=...)`, `todo(action="list")`, or
 * `todo(action="done", id=...)`. State lives on the host process,
 * not in engine.
 *
 *   OPENROUTER_API_KEY=sk-or-... npm run example:custom-tool
 *
 * Try:
 *   add three things: buy milk, walk dog, write report
 *   list them
 *   mark the first one done, then list again
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

import {
  createHukoEngine,
  MemoryAgentPersistence,
  FOUNDATIONAL_TOOL_REGISTRATIONS,
  type ServerToolHandler,
  type ServerToolDefinition,
} from "../../src/index.js";

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  stderr.write("Set OPENROUTER_API_KEY first.\n");
  process.exit(1);
}

// ─── 1. The tool ──────────────────────────────────────────────────────────

type Todo = { id: number; text: string; done: boolean };
const todos = new Map<number, Todo>();
let nextId = 1;

const todoDefinition: ServerToolDefinition = {
  name: "todo",
  description:
    "Manage a simple todo list. " +
    "Use action='add' with text to create an item, " +
    "action='list' to see all items, " +
    "action='done' with id to mark an item complete.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "list", "done"],
        description: "What to do",
      },
      text: { type: "string", description: "Item text (required for 'add')" },
      id: { type: "number", description: "Item id (required for 'done')" },
    },
    required: ["action"],
  },
  dangerLevel: "safe",
};

const todoHandler: ServerToolHandler = async (args) => {
  const action = String(args["action"]);
  if (action === "add") {
    const text = String(args["text"] ?? "").trim();
    if (!text) return { content: "", error: "text required for action=add" };
    const id = nextId++;
    todos.set(id, { id, text, done: false });
    return `Added #${id}: ${text}`;
  }
  if (action === "list") {
    if (todos.size === 0) return "(empty)";
    return [...todos.values()]
      .map((t) => `${t.done ? "[x]" : "[ ]"} #${t.id} ${t.text}`)
      .join("\n");
  }
  if (action === "done") {
    const id = Number(args["id"]);
    const item = todos.get(id);
    if (!item) return { content: "", error: `no item with id=${id}` };
    item.done = true;
    return `Marked #${id} done`;
  }
  return { content: "", error: `unknown action: ${action}` };
};

// ─── 2. Wire it up ────────────────────────────────────────────────────────

const engine = await createHukoEngine({
  persistence: new MemoryAgentPersistence(),
});

// Register your tool on the engine instance — it sits alongside the
// auto-registered foundational tools.
engine.registerTool({ ...todoDefinition, handler: todoHandler });

const agent = engine.createAgent({
  name: "custom-tool",
  sessionId: await engine.createSession({ title: "custom-tool" }),
  defaultProvider: {
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    modelId: process.env["MODEL"] ?? "deepseek/deepseek-v4-pro",
    toolCallMode: "native",
    thinkLevel: "off",
    contextWindow: 128_000,
  },
  cwd: process.cwd(),
  // The agent only sees what's in `allow` — add "todo" explicitly,
  // plus whichever foundational tools you also want available.
  tools: { allow: ["todo", ...FOUNDATIONAL_TOOL_REGISTRATIONS.map((r) => r.name)] },
});

// ─── 3. Stream output (same as cli-chat) ──────────────────────────────────

const BOLD_YELLOW = "\x1b[1;33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

agent.onEvent((ev) => {
  if (ev.type === "assistant_content_delta") {
    stdout.write(ev.delta);
  } else if (ev.type === "assistant_complete") {
    if (ev.toolCalls?.length) {
      for (const tc of ev.toolCalls) {
        stderr.write(`${DIM}  · ${tc.name}(${JSON.stringify(tc.arguments)})${RESET}\n`);
      }
    } else {
      stdout.write("\n");
    }
  } else if (ev.type === "tool_result") {
    if (ev.toolName === "message" && typeof ev.metadata?.["text"] === "string") {
      const kind = String(ev.metadata["messageType"] ?? "info");
      stdout.write(`\n${BOLD_YELLOW}[${kind}]${RESET} ${ev.metadata["text"]}\n`);
    } else if (ev.error) {
      stderr.write(`${DIM}  ← ${ev.toolName}: ${ev.error}${RESET}\n`);
    } else {
      stderr.write(`${DIM}  ← ${ev.toolName}: ${ev.content.split("\n")[0]}${RESET}\n`);
    }
  } else if (ev.type === "task_error") {
    stderr.write(`  ! ${ev.error}\n`);
  }
});

const rl = createInterface({ input: stdin, output: stdout });
stdout.write(`huko custom-tool — agent has a 'todo' tool\n`);
stdout.write(`try: "add three things: milk, dog, report. then list them."\n`);

for (;;) {
  const line = (await rl.question("\nyou> ")).trim();
  if (!line) break;
  await agent.runTurn({ message: line });
}

rl.close();
await engine.close();

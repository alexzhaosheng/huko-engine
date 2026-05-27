/**
 * example/with-sqlite — same shape as cli-chat, persisted to disk.
 *
 * The only meaningful change from `example/cli-chat`:
 *
 *   - new MemoryAgentPersistence()              // forgets on exit
 *   + new SqliteAgentPersistence("./agent.db")  // survives restarts
 *
 * Engine handles the rest — schema is applied lazily on first use,
 * orphan recovery scans the SAME db on next boot, and every turn's
 * entries are written through transparently.
 *
 * From the engine repo root, after `npm install`:
 *
 *   OPENROUTER_API_KEY=sk-or-... npm run example:with-sqlite
 *
 * Run it twice. The second run finds the previous sessions in the
 * db and starts a fresh one alongside.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

import {
  createHukoEngine,
  SqliteAgentPersistence,
  FOUNDATIONAL_TOOL_REGISTRATIONS,
} from "../../src/index.js";

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  stderr.write("Set OPENROUTER_API_KEY first.\n");
  process.exit(1);
}

const dbPath = process.env["DB_PATH"] ?? "./agent.db";
const modelId = process.env["MODEL"] ?? "deepseek/deepseek-v4-pro";

const persistence = new SqliteAgentPersistence(dbPath);

// Sqlite handle is exposed for host-side queries that the engine's
// narrow `AgentPersistence` interface doesn't cover (session lists,
// search, etc.). cli + app-studio both build richer surfaces on top
// of this raw handle.
const priorCount = (persistence.db
  .prepare("SELECT COUNT(*) as n FROM sessions")
  .get() as { n: number }).n;

const engine = await createHukoEngine({ persistence });
const sessionId = await engine.createSession({ title: "with-sqlite" });

stdout.write(
  `${dbPath} has ${priorCount} prior session(s). Starting fresh as #${sessionId}.\n`,
);

const agent = engine.createAgent({
  name: "with-sqlite",
  sessionId,
  defaultProvider: {
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    modelId,
    toolCallMode: "native",
    thinkLevel: "off",
    contextWindow: 128_000,
  },
  cwd: process.cwd(),
  tools: { allow: FOUNDATIONAL_TOOL_REGISTRATIONS.map((r) => r.name) },
});

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
      stderr.write(`${DIM}  ← ${ev.toolName} ok${RESET}\n`);
    }
  } else if (ev.type === "task_error") {
    stderr.write(`  ! ${ev.error}\n`);
  }
});

const rl = createInterface({ input: stdin, output: stdout });
stdout.write(`huko with-sqlite — ${modelId}\n`);
stdout.write(`type a message and hit enter. blank line to quit.\n`);

for (;;) {
  const line = (await rl.question("\nyou> ")).trim();
  if (!line) break;
  await agent.runTurn({ message: line });
}

rl.close();
await engine.close();

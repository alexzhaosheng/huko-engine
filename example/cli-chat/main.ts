/**
 * example/cli-chat — minimal terminal chat agent.
 *
 * Streams the assistant's reply to stdout and lets the agent use every
 * default foundational tool (bash, file ops, web fetch / search).
 * In-memory persistence: the conversation lives only as long as the
 * process.
 *
 * From the repo root, after `npm install`:
 *
 *   OPENROUTER_API_KEY=sk-or-... npm run example:cli-chat
 *
 * Override the model with `MODEL=...` (any OpenRouter slug).
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

import {
  createHukoEngine,
  MemoryAgentPersistence,
  FOUNDATIONAL_TOOL_REGISTRATIONS,
} from "../../src/index.js";

const apiKey = process.env["OPENROUTER_API_KEY"];
if (!apiKey) {
  stderr.write("Set OPENROUTER_API_KEY first.\n");
  process.exit(1);
}

const modelId = process.env["MODEL"] ?? "deepseek/deepseek-v4-pro";

const engine = await createHukoEngine({
  persistence: new MemoryAgentPersistence(),
});

const agent = engine.createAgent({
  name: "cli-chat",
  sessionId: await engine.createSession({ title: "cli-chat" }),
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
  // Whitelist every foundational tool. Drop names from this list for
  // a narrower surface, or omit `tools` entirely for a tool-less chat.
  tools: { allow: FOUNDATIONAL_TOOL_REGISTRATIONS.map((r) => r.name) },
});

// ANSI colors. The `message` tool is the agent's user-facing voice —
// highlight it so it stands out from tool-result chatter.
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
stdout.write(`huko cli-chat — ${modelId}\n`);
stdout.write(`type a message and hit enter. blank line to quit.\n`);

for (;;) {
  const line = (await rl.question("\nyou> ")).trim();
  if (!line) break;
  await agent.runTurn({ message: line });
}

rl.close();
await engine.close();

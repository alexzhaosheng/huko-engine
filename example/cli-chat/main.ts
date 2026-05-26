/**
 * example/cli-chat — minimal terminal chat agent.
 *
 * Streams the assistant's reply to stdout and lets the agent use every
 * default foundational tool (bash, file ops, web fetch / search).
 * In-memory persistence: the conversation lives only as long as the
 * process.
 *
 * Run:
 *
 *   OPENROUTER_API_KEY=sk-or-... npx tsx example/cli-chat/main.ts
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

agent.onEvent((ev) => {
  if (ev.type === "assistant_content_delta") stdout.write(ev.delta);
  else if (ev.type === "assistant_complete") stdout.write("\n");
  else if (ev.type === "tool_result") {
    stderr.write(`  · ${ev.toolName}${ev.error ? ` (${ev.error})` : ""}\n`);
  } else if (ev.type === "task_error") {
    stderr.write(`  ! ${ev.error}\n`);
  }
});

const rl = createInterface({ input: stdin, output: stdout });
stdout.write(`huko cli-chat — ${modelId}\n`);

for (;;) {
  const line = (await rl.question("\nyou> ")).trim();
  if (!line) break;
  await agent.runTurn({ message: line });
}

rl.close();
await engine.close();

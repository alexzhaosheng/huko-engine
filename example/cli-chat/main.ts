/**
 * example/cli-chat — minimal terminal chat agent.
 *
 * Reads from stdin, streams the assistant's reply to stdout, and
 * lets the agent use every default foundational tool (bash, file
 * ops, web fetch / search). Persistence is in-memory, so the
 * conversation lives only as long as the process.
 *
 * Run:
 *
 *   OPENROUTER_API_KEY=sk-or-... npx tsx example/cli-chat/main.ts
 *
 * Optional env:
 *
 *   MODEL=anthropic/claude-3.5-haiku      # default
 *   OPENAI_BASE_URL=https://...           # any OpenAI-protocol endpoint
 *   OPENAI_API_KEY=...                    # if you're not on OpenRouter
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";

import {
  createHukoEngine,
  MemoryAgentPersistence,
  FOUNDATIONAL_TOOL_REGISTRATIONS,
  type HukoEvent,
  type Provider,
} from "../../src/index.js";

const apiKey = process.env["OPENROUTER_API_KEY"] ?? process.env["OPENAI_API_KEY"];
if (!apiKey) {
  stderr.write(
    "Set OPENROUTER_API_KEY (or OPENAI_API_KEY + OPENAI_BASE_URL) first.\n",
  );
  process.exit(1);
}

const provider: Provider = {
  protocol: "openai",
  baseUrl: process.env["OPENAI_BASE_URL"] ?? "https://openrouter.ai/api/v1",
  apiKey,
  modelId: process.env["MODEL"] ?? "anthropic/claude-3.5-haiku",
  toolCallMode: "native",
  thinkLevel: "off",
  contextWindow: 128_000,
};

// `createHukoEngine` auto-registers the 13 foundational tools and the
// default best-practices provider unless you opt out. Memory persistence
// is fine for a one-shot CLI session.
const engine = await createHukoEngine({
  persistence: new MemoryAgentPersistence(),
});

const sessionId = await engine.createSession({ title: "cli-chat" });

const agent = engine.createAgent({
  name: "cli-chat",
  sessionId,
  defaultProvider: provider,
  cwd: process.cwd(),
  // Whitelist every foundational tool by name. Without `tools.allow`
  // the agent renders zero tools to the LLM.
  tools: {
    allow: FOUNDATIONAL_TOOL_REGISTRATIONS.map((reg) => reg.name),
  },
});

agent.onEvent((ev: HukoEvent) => {
  switch (ev.type) {
    case "assistant_content_delta":
      stdout.write(ev.delta);
      break;
    case "assistant_complete":
      stdout.write("\n");
      if (ev.toolCalls?.length) {
        for (const tc of ev.toolCalls) {
          stderr.write(`  · calling ${tc.name}\n`);
        }
      }
      break;
    case "tool_result": {
      if (ev.error) {
        stderr.write(`  · ${ev.toolName}: error — ${ev.error}\n`);
      } else {
        const first = ev.content.split("\n", 1)[0] ?? "";
        const preview = first.length > 80 ? `${first.slice(0, 80)}…` : first;
        stderr.write(`  · ${ev.toolName}: ${preview}\n`);
      }
      break;
    }
    case "task_error":
      stderr.write(`  ! task error: ${ev.error}\n`);
      break;
  }
});

const rl = createInterface({ input: stdin, output: stdout });
stdout.write(`huko cli-chat — model: ${provider.modelId}\n`);
stdout.write(`type a message, blank line or Ctrl+D to quit\n`);

try {
  for (;;) {
    const line = (await rl.question("\nyou> ")).trim();
    if (!line) break;
    await agent.runTurn({ message: line });
  }
} finally {
  rl.close();
  await engine.close();
}

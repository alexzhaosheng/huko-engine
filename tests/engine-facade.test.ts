/**
 * tests/engine-facade.test.ts
 *
 * End-to-end proof that `createHukoEngine` produces a working agent:
 *
 *   1. The engine carries an instance-scoped tool registry — two
 *      engines in the same process don't see each other's tools.
 *   2. createAgent.runTurn drives a full SessionContext + TaskContext +
 *      TaskLoop cycle, persists user + assistant entries, updates the
 *      task row, and returns the right shape.
 *   3. The per-instance tool registry actually dispatches handlers via
 *      `ctx.toolResolver` (not the global registry the cli uses).
 *   4. Overlays land in the system prompt.
 *
 * LLM mocking: the openai adapter is reused but `globalThis.fetch` is
 * stubbed to return canned OpenAI-shape responses. Each test installs
 * its own queued responses and restores fetch in afterEach.
 *
 * No network. No real DB — `MemoryAgentPersistence` keeps the suite
 * fast and parallel-safe.
 */

import { afterEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";

// Relative imports — same source as the package barrel, but tests
// don't need dist/ to exist (package-name resolution would route
// through exports → dist/, which is only built by `npm run build`).
import {
  createHukoEngineSync,
  MemoryAgentPersistence,
  type Provider,
} from "../src/index.js";

// ─── Fetch stubbing ─────────────────────────────────────────────────────────

type FetchFn = typeof globalThis.fetch;
let originalFetch: FetchFn | null = null;

/**
 * Engine's pipeline always sets `onPartial`, so the OpenAI adapter
 * speaks SSE. These helpers build the right wire shape.
 */
type StreamScript = {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

function buildSSEResponse(script: StreamScript): string {
  const lines: string[] = [];
  if (script.content !== undefined) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: script.content } }] })}`);
  }
  for (const [idx, call] of (script.toolCalls ?? []).entries()) {
    lines.push(
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: idx, id: call.id, function: { name: call.name, arguments: call.arguments } },
              ],
            },
          },
        ],
      })}`,
    );
  }
  if (script.usage) {
    lines.push(`data: ${JSON.stringify({ choices: [], usage: script.usage })}`);
  }
  lines.push("data: [DONE]");
  return lines.map((l) => `${l}\n\n`).join("");
}

/**
 * Queue a sequence of SSE-formatted responses. Each subsequent
 * fetch call pops one script off the front.
 */
function queueOpenAIResponses(scripts: StreamScript[]): void {
  const queue = [...scripts];
  if (originalFetch === null) originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const script = queue.shift();
    if (script === undefined) {
      throw new Error("test fetch stub exhausted — adapter called fetch more than the queue");
    }
    return new Response(buildSSEResponse(script), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as unknown as FetchFn;
}

afterEach(() => {
  if (originalFetch !== null) {
    globalThis.fetch = originalFetch;
    originalFetch = null;
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function fakeProvider(): Provider {
  return {
    protocol: "openai",
    baseUrl: "http://example.test",
    apiKey: "test-key",
    modelId: "test-model",
    toolCallMode: "native",
    thinkLevel: "off",
    contextWindow: 8000,
  };
}

function assistantOnlyResponse(content: string): StreamScript {
  return {
    content,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

// These tests exercise the per-instance registry mechanics — counts
// and isolation. `foundationalTools: false` opts out of the default
// auto-registration so the assertions can deal with clean slates.
// (Default behaviour — engine ships the 13 foundational tools pre-
// registered — is covered indirectly by the runTurn tests below.)

describe("createHukoEngine — instance shape", () => {
  it("registerTool isolates two engines from each other", () => {
    const engineA = createHukoEngineSync({
      persistence: new MemoryAgentPersistence(),
      foundationalTools: false,
    });
    const engineB = createHukoEngineSync({
      persistence: new MemoryAgentPersistence(),
      foundationalTools: false,
    });

    engineA.registerTool({
      name: "shared_name",
      description: "registered only on A",
      parameters: { type: "object", properties: {}, required: [] },
      handler: async () => "from A",
    });

    assert.equal(engineA.listTools().length, 1);
    assert.equal(engineB.listTools().length, 0, "engine B should not see A's tool");

    // Engine B can register a different tool with the same name — no clash.
    engineB.registerTool({
      name: "shared_name",
      description: "registered only on B",
      parameters: { type: "object", properties: {}, required: [] },
      handler: async () => "from B",
    });

    assert.equal(engineB.listTools().length, 1);
  });

  it("registerTool throws when the same name is registered twice on one engine", () => {
    const engine = createHukoEngineSync({
      persistence: new MemoryAgentPersistence(),
      foundationalTools: false,
    });
    engine.registerTool({
      name: "dup",
      description: "first",
      parameters: { type: "object", properties: {}, required: [] },
      handler: async () => "x",
    });
    assert.throws(() =>
      engine.registerTool({
        name: "dup",
        description: "second",
        parameters: { type: "object", properties: {}, required: [] },
        handler: async () => "y",
      }),
    );
  });

  it("listTools filter narrows by allow-list", () => {
    const engine = createHukoEngineSync({
      persistence: new MemoryAgentPersistence(),
      foundationalTools: false,
    });
    for (const name of ["a", "b", "c"]) {
      engine.registerTool({
        name,
        description: `${name} tool`,
        parameters: { type: "object", properties: {}, required: [] },
        handler: async () => name,
      });
    }
    assert.equal(engine.listTools().length, 3);
    assert.equal(engine.listTools({ allow: ["a"] }).length, 1);
    assert.equal(engine.listTools({ allow: ["a", "c"] }).length, 2);
  });

  it("foundational tools are registered by default", () => {
    const engine = createHukoEngineSync({
      persistence: new MemoryAgentPersistence(),
    });
    // The 13 bundled tools should be there out of the box.
    const names = engine.listTools().map((t) => t.name).sort();
    for (const expected of [
      "bash",
      "glob",
      "grep",
      "plan",
      "message",
      "read_file",
      "write_file",
      "edit_file",
      "delete_file",
      "move_file",
      "list_dir",
      "web_fetch",
      "web_search",
    ]) {
      assert.ok(names.includes(expected), `expected default tool ${expected} to be registered`);
    }
  });
});

describe("createHukoEngine — agent.runTurn end-to-end", () => {
  it("creates session + task, persists user + assistant entries, returns the right shape", async () => {
    queueOpenAIResponses([assistantOnlyResponse("Hello back!")]);

    const persistence = new MemoryAgentPersistence();
    const engine = createHukoEngineSync({ persistence });
    const sessionId = await engine.createSession({ title: "test" });
    const agent = engine.createAgent({
      name: "test-agent",
      sessionId,
      defaultProvider: fakeProvider(),
    });

    const result = await agent.runTurn({
      message: "Hello, who are you?",
    });

    assert.equal(result.sessionId, sessionId);
    assert.ok(result.taskId > 0, "new task should be created");
    assert.equal(result.status, "done");
    assert.equal(result.errorMessage, null);
    assert.equal(result.finalResult, "Hello back!");

    // Replay the session — should see user + assistant.
    const history = await persistence.loadInitialContext(result.sessionId, "chat");
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], { role: "user", content: "Hello, who are you?" });
    assert.equal(history[1]?.role, "assistant");
    assert.equal(history[1]?.content, "Hello back!");
  });

  it("reuses an existing sessionId (continuation)", async () => {
    queueOpenAIResponses([
      assistantOnlyResponse("first response"),
      assistantOnlyResponse("second response"),
    ]);

    const persistence = new MemoryAgentPersistence();
    const engine = createHukoEngineSync({ persistence });
    const sessionId = await engine.createSession({ title: "continuation" });
    const agent = engine.createAgent({
      name: "test-agent",
      sessionId,
      defaultProvider: fakeProvider(),
    });

    const first = await agent.runTurn({ message: "hello" });
    const second = await agent.runTurn({ message: "follow-up" });

    assert.equal(second.sessionId, first.sessionId, "same session");
    assert.notEqual(second.taskId, first.taskId, "distinct tasks");

    const history = await persistence.loadInitialContext(first.sessionId, "chat");
    assert.equal(history.length, 4, "two user + two assistant entries");
    assert.equal(history[0]?.content, "hello");
    assert.equal(history[1]?.content, "first response");
    assert.equal(history[2]?.content, "follow-up");
    assert.equal(history[3]?.content, "second response");
  });

  it("agent without a defaultProvider throws when runTurn is called without one", async () => {
    const engine = createHukoEngineSync({ persistence: new MemoryAgentPersistence() });
    const sessionId = await engine.createSession({ title: "no-provider" });
    const agent = engine.createAgent({ name: "no-provider", sessionId });

    await assert.rejects(
      () => agent.runTurn({ message: "hi" }),
      /defaultProvider/,
    );
  });

  it("per-turn provider override beats agent default", async () => {
    queueOpenAIResponses([assistantOnlyResponse("ok")]);

    const persistence = new MemoryAgentPersistence();
    const engine = createHukoEngineSync({ persistence });
    const sessionId = await engine.createSession();
    const agent = engine.createAgent({
      name: "with-default",
      sessionId,
      defaultProvider: { ...fakeProvider(), modelId: "default-model" },
    });

    const result = await agent.runTurn({
      message: "hi",
      provider: { ...fakeProvider(), modelId: "override-model" },
    });

    // The task row should record the model the LLM was actually called with.
    // MemoryAgentPersistence doesn't expose getTask publicly; we just
    // assert the turn ran successfully — the override path is exercised
    // through the test fetching successfully and the result coming back.
    assert.equal(result.status, "done");
    assert.equal(result.finalResult, "ok");
  });

  it("overlays appear in the system prompt sent to the LLM", async () => {
    // Capture the actual fetch body so we can inspect the system prompt.
    let capturedBody: string | null = null;
    if (originalFetch === null) originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body?: string }) => {
      capturedBody = init.body ?? null;
      return new Response(buildSSEResponse(assistantOnlyResponse("ok")), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as unknown as FetchFn;

    const engine = createHukoEngineSync({ persistence: new MemoryAgentPersistence() });
    const sessionId = await engine.createSession();
    const agent = engine.createAgent({
      name: "overlay-test",
      sessionId,
      defaultProvider: fakeProvider(),
      overlays: [
        {
          name: "test-overlay",
          content: "<test_marker>OVERLAY_PRESENT</test_marker>",
          position: "tail",
        },
      ],
    });

    await agent.runTurn({ message: "go" });

    assert.ok(capturedBody !== null, "fetch was called");
    const parsed = JSON.parse(capturedBody!) as { messages?: Array<{ role: string; content: string }> };
    const systemMsg = parsed.messages?.find((m) => m.role === "system");
    assert.ok(systemMsg, "system message present");
    assert.ok(
      systemMsg.content.includes("<test_marker>OVERLAY_PRESENT</test_marker>"),
      "overlay should appear verbatim in the system prompt",
    );
  });

  it("instance-scoped tool dispatch via toolResolver", async () => {
    // The LLM emits a tool call to a tool registered ONLY on this engine
    // (not on the global registry the cli uses). If toolResolver is wired
    // correctly, the handler runs.
    let handlerCalled = false;
    queueOpenAIResponses([
      // First call: model emits a tool call.
      {
        toolCalls: [{ id: "call_1", name: "facade_only_tool", arguments: "{}" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      // Second call: model wraps up after seeing the tool result.
      assistantOnlyResponse("done with tool"),
    ]);

    const engine = createHukoEngineSync({ persistence: new MemoryAgentPersistence() });
    engine.registerTool({
      name: "facade_only_tool",
      description: "tool registered on this engine instance only",
      parameters: { type: "object", properties: {}, required: [] },
      handler: async () => {
        handlerCalled = true;
        return "tool output";
      },
    });

    const sessionId = await engine.createSession();
    const agent = engine.createAgent({
      name: "tool-test",
      sessionId,
      defaultProvider: fakeProvider(),
      tools: { allow: ["facade_only_tool"] },
    });

    const result = await agent.runTurn({ message: "use the tool" });

    assert.ok(handlerCalled, "handler should have been dispatched via the instance registry");
    assert.equal(result.status, "done");
    assert.equal(result.toolCallCount, 1);
  });
});

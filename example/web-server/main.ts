/**
 * example/web-server — Node http server that streams agent events
 * to the browser over Server-Sent Events.
 *
 * Open http://localhost:3000 in a browser, type a prompt, watch
 * the assistant stream tokens + tool calls + tool results in
 * real time.
 *
 * Single shared engine + agent — one session for the demo. A real
 * app would call `engine.createSession()` per browser tab and pin
 * each one to its own `HukoAgent`. Same `onEvent` subscription
 * pattern either way.
 *
 *   OPENROUTER_API_KEY=sk-or-... npm run example:web-server
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { stderr } from "node:process";

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

const port = Number(process.env["PORT"] ?? 3000);

const engine = await createHukoEngine({
  persistence: new MemoryAgentPersistence(),
});

const agent = engine.createAgent({
  name: "web-server",
  sessionId: await engine.createSession({ title: "web" }),
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
  tools: { allow: FOUNDATIONAL_TOOL_REGISTRATIONS.map((r) => r.name) },
});

// ─── SSE handler ──────────────────────────────────────────────────────────

async function handleTurn(req: IncomingMessage, res: ServerResponse, msg: string): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Subscribe BEFORE startTurn so we don't miss the assistant_started.
  // The agent fans every HukoEvent to every active subscriber.
  const unsubscribe = agent.onEvent((ev) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  });

  try {
    const result = await agent.runTurn({ message: msg });
    res.write(`event: done\ndata: ${JSON.stringify({ status: result.status })}\n\n`);
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`);
  } finally {
    unsubscribe();
    res.end();
  }
}

// ─── HTML demo page ───────────────────────────────────────────────────────

const HTML = `<!doctype html>
<html><head><title>huko web demo</title>
<style>
  body { font: 14px/1.5 system-ui; max-width: 720px; margin: 2em auto; padding: 0 1em; }
  textarea { width: 100%; height: 4em; font: inherit; padding: 0.5em; }
  button { padding: 0.5em 1em; font: inherit; }
  #out { white-space: pre-wrap; background: #f6f6f6; padding: 1em; margin-top: 1em; min-height: 4em; }
  .tool { color: #888; }
  .msg { color: #b58900; font-weight: bold; }
</style></head>
<body>
<h2>huko web demo</h2>
<textarea id="prompt" placeholder="say something to the agent..."></textarea>
<button id="go">Send</button>
<div id="out"></div>
<script>
const out = document.getElementById("out");
document.getElementById("go").onclick = () => {
  const msg = document.getElementById("prompt").value.trim();
  if (!msg) return;
  out.textContent = "";
  const es = new EventSource("/turn?msg=" + encodeURIComponent(msg));
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "assistant_content_delta") out.append(ev.delta);
    else if (ev.type === "tool_result" && ev.toolName === "message" && ev.metadata?.text) {
      const span = document.createElement("span");
      span.className = "msg";
      span.textContent = "\\n[" + (ev.metadata.messageType || "info") + "] " + ev.metadata.text + "\\n";
      out.appendChild(span);
    } else if (ev.type === "assistant_complete" && ev.toolCalls?.length) {
      const span = document.createElement("span");
      span.className = "tool";
      span.textContent = "\\n· " + ev.toolCalls.map(t => t.name).join(", ") + "\\n";
      out.appendChild(span);
    }
  };
  es.addEventListener("done", () => es.close());
  es.addEventListener("error", () => es.close());
};
</script>
</body></html>`;

// ─── Server ───────────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }
  if (req.method === "GET" && url.pathname === "/turn") {
    const msg = url.searchParams.get("msg") ?? "";
    if (!msg) {
      res.writeHead(400);
      res.end("missing msg");
      return;
    }
    void handleTurn(req, res, msg);
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  stderr.write(`huko web demo listening on http://localhost:${port}\n`);
});

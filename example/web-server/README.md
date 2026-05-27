# example/web-server

Browser-facing demo: a minimal Node http server (no Express — just
`node:http`) that streams agent events over Server-Sent Events. Open
the page, type a prompt, watch assistant tokens + tool calls flow
into the page in real time.

## Run

```bash
OPENROUTER_API_KEY=sk-or-... npm run example:web-server
```

Opens on `http://localhost:3000`. Override with `PORT=4000`.

## What it shows

- The "subscribe to events, run turn, stream events to the wire"
  pattern that daemon-style hosts use. `agent.onEvent` fans every
  `HukoEvent` to every subscriber; the SSE response is just one of
  them.
- Single shared engine + agent serves the demo. A real app would
  call `engine.createSession()` per browser tab so each user gets
  their own conversation history, and instantiate a `HukoAgent`
  pinned to that session.
- `runTurn` vs `startTurn`: this example uses `runTurn` because we
  await the end before closing the SSE stream. Daemons that want
  mid-flight stop / operator decision routing use `startTurn`
  directly (returns a `TaskHandle` with `taskId` so you can stop
  it later).

## Going further

- For two-way operator interaction (`message(type=ask)` flow), wire
  `agent.onAsk(...)` and `agent.respondToAsk(askId, ...)`. The
  browser would surface the question and post the answer back to a
  `/respond` endpoint.
- For multiple concurrent users, give each browser tab its own
  session id (cookie / query param) and look up the matching
  `HukoAgent` in a `Map<sessionId, HukoAgent>` per request.

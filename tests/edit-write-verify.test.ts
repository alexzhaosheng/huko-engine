/**
 * tests/edit-write-verify.test.ts
 *
 * End-to-end coverage of `edit_file` + `write_file` with verify enabled
 * / disabled. Goes through the registered tool handler (same path the
 * LLM takes) so we catch any wiring drift between the helpers and the
 * tool surface.
 *
 * Three things this pins:
 *
 *   1. Default (verify=true) → tool_result has `[verify] write integrity OK`.
 *   2. verify=false → tool_result has NO `[verify]` lines (both layers skipped).
 *   3. Atomic write is in use: the temp+rename path leaves no `.tmp.*`
 *      orphans after a successful edit/write.
 *
 * Layer 2 (project verify) is covered by the standalone projectVerify
 * tests; here we set verifyCommand to a `node -e "process.exit(0)"`
 * no-op so the tool surface gets exercised end-to-end including the
 * Layer 2 hook, on every platform (POSIX `true`/`false` aren't
 * guaranteed on Windows cmd.exe — Git Bash ships them but CI
 * shouldn't depend on PATH layout).
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

// Side-effect: register all tools.
import "../src/task/tools/index.js";
import { getTool, type ToolHandlerResult } from "../src/index.js";
import type { TaskContext } from "../src/index.js";
import {
  DEFAULT_ENGINE_CONFIG,
  setEngineConfig,
  _resetEngineConfigForTests,
} from "../src/index.js";

function ctxFor(cwd: string): TaskContext {
  return { taskId: 1, cwd } as unknown as TaskContext;
}

function setVerify(cmd: string, timeoutMs = 5000): void {
  setEngineConfig({
    ...DEFAULT_ENGINE_CONFIG,
    edit: { verifyCommand: cmd, verifyTimeoutMs: timeoutMs },
  });
}

async function call(name: string, args: Record<string, unknown>, ctx: TaskContext): Promise<ToolHandlerResult> {
  const tool = getTool(name);
  if (!tool || tool.kind !== "server") throw new Error(`${name} not registered`);
  const r = await Promise.resolve(tool.handler(args, ctx, { toolCallId: "t" }));
  if (typeof r === "string") return { content: r };
  if ("content" in r) return r as ToolHandlerResult;
  return { content: r.result, error: r.error ?? null };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(tmpdir(), "huko-ewv-"));
  _resetEngineConfigForTests();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  _resetEngineConfigForTests();
});

// ─── write_file ──────────────────────────────────────────────────────────────

describe("write_file with verify", () => {
  it("default: includes [verify] write integrity OK line", async () => {
    // no edit.verifyCommand → Layer 2 silently skipped
    const target = path.join(tmp, "out.txt");
    const r = await call("write_file", { path: target, content: "hello\n" }, ctxFor(tmp));
    assert.equal(r.error, undefined);
    assert.match(r.content, /\[verify\] write integrity OK \(6 bytes match\)/);
    assert.doesNotMatch(r.content, /project check/);
    assert.equal(fs.readFileSync(target, "utf8"), "hello\n");
  });

  it("verify=false: NO [verify] lines at all", async () => {
    const target = path.join(tmp, "out.txt");
    const r = await call(
      "write_file",
      { path: target, content: "hi", verify: false },
      ctxFor(tmp),
    );
    assert.equal(r.error, undefined);
    assert.doesNotMatch(r.content, /\[verify\]/);
  });

  it("Layer 2 ok: includes both Layer 1 and Layer 2 success lines", async () => {
    // `node -e "..."` instead of `true` — `true` is a POSIX builtin
    // not guaranteed on Windows cmd.exe (Git Bash ships one, but
    // CI shouldn't depend on it being on PATH).
    setVerify(`node -e "process.exit(0)"`);
    const target = path.join(tmp, "out.txt");
    const r = await call("write_file", { path: target, content: "x" }, ctxFor(tmp));
    assert.equal(r.error, undefined);
    assert.match(r.content, /write integrity OK/);
    // The verify command is echoed back into the report.
    assert.match(r.content, /project check OK \(node -e /);
  });

  it("Layer 2 failure: surfaces error + output for the LLM", async () => {
    // Use `node -e` so the fixture works on Windows cmd.exe too (the
    // bash-only `echo ... >&2` form failed CI with exit 0 on Windows).
    setVerify(`node -e "process.stderr.write('foo.ts(5): err\\n'); process.exit(2)"`);
    const target = path.join(tmp, "out.txt");
    const r = await call("write_file", { path: target, content: "x" }, ctxFor(tmp));
    assert.equal(r.error, "project verify failed");
    assert.match(r.content, /project check FAILED/);
    assert.match(r.content, /foo\.ts\(5\): err/);
    assert.match(r.content, /fix forward or revert/);
    // File was still written — atomic rename committed.
    assert.equal(fs.readFileSync(target, "utf8"), "x");
  });

  it("leaves no .tmp.* orphans after a successful write", async () => {
    const target = path.join(tmp, "out.txt");
    await call("write_file", { path: target, content: "hi" }, ctxFor(tmp));
    const orphans = fs.readdirSync(tmp).filter((n) => n.includes(".tmp."));
    assert.deepEqual(orphans, []);
  });
});

// ─── edit_file ──────────────────────────────────────────────────────────────

describe("edit_file with verify", () => {
  it("default: includes [verify] write integrity OK after a successful edit", async () => {
    const target = path.join(tmp, "code.ts");
    fs.writeFileSync(target, "const x = 1;\nconst y = 2;\n");

    const r = await call(
      "edit_file",
      {
        path: target,
        edits: [{ find: "const x = 1;", replace: "const x = 42;" }],
      },
      ctxFor(tmp),
    );
    assert.equal(r.error, undefined);
    assert.match(r.content, /\[verify\] write integrity OK/);
    assert.equal(fs.readFileSync(target, "utf8"), "const x = 42;\nconst y = 2;\n");
  });

  it("verify=false: skips both layers", async () => {
    const target = path.join(tmp, "code.ts");
    fs.writeFileSync(target, "old");

    const r = await call(
      "edit_file",
      {
        path: target,
        edits: [{ find: "old", replace: "new" }],
        verify: false,
      },
      ctxFor(tmp),
    );
    assert.equal(r.error, undefined);
    assert.doesNotMatch(r.content, /\[verify\]/);
    assert.equal(fs.readFileSync(target, "utf8"), "new");
  });

  it("missing file: hints write_file in the error (one-liner per project convention)", async () => {
    const r = await call(
      "edit_file",
      {
        path: path.join(tmp, "ghost.ts"),
        edits: [{ find: "a", replace: "b" }],
      },
      ctxFor(tmp),
    );
    assert.equal(r.error, "not found");
    assert.match(r.content, /does not exist/);
    assert.match(r.content, /write_file/);
  });

  it("leaves no .tmp.* orphans after a successful multi-edit", async () => {
    const target = path.join(tmp, "code.ts");
    fs.writeFileSync(target, "a\nb\nc\n");

    await call(
      "edit_file",
      {
        path: target,
        edits: [
          { find: "a", replace: "A" },
          { find: "c", replace: "C" },
        ],
      },
      ctxFor(tmp),
    );
    const orphans = fs.readdirSync(tmp).filter((n) => n.includes(".tmp."));
    assert.deepEqual(orphans, []);
  });

  it("Layer 2 failure on edit: error surfaced but edit IS on disk (no rollback)", async () => {
    // `node -e` for the same cross-platform reason as the success
    // case above.
    setVerify(`node -e "process.exit(1)"`);
    const target = path.join(tmp, "code.ts");
    fs.writeFileSync(target, "old");

    const r = await call(
      "edit_file",
      {
        path: target,
        edits: [{ find: "old", replace: "new" }],
      },
      ctxFor(tmp),
    );
    assert.equal(r.error, "project verify failed");
    assert.match(r.content, /project check FAILED/);
    // Edit was applied — Layer 2 failure doesn't roll back.
    assert.equal(fs.readFileSync(target, "utf8"), "new");
  });
});

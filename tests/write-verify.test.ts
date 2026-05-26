/**
 * tests/write-verify.test.ts
 *
 * Coverage for the two verify layers in `_write-verify.ts`.
 *
 *   - Layer 1 (readback): asserts that byte-equal → ok, length mismatch
 *     → truncated/expanded reason, byte mismatch → first-diff offset.
 *   - Layer 2 (projectVerify): asserts skipped (no config), ok (cmd
 *     exits 0), failed (non-zero exit + captured output), failed with
 *     timeout (timeoutMs forced low).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  projectVerify,
  readbackVerify,
  renderVerifyReport,
} from "../src/task/tools/_write-verify.js";
import {
  DEFAULT_ENGINE_CONFIG,
  setEngineConfig,
  _resetEngineConfigForTests,
} from "../src/index.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(tmpdir(), "huko-verify-"));
  _resetEngineConfigForTests();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  _resetEngineConfigForTests();
});

// ─── Layer 1: readback ───────────────────────────────────────────────────────

describe("readbackVerify — Layer 1", () => {
  it("returns ok when on-disk bytes equal intended content", () => {
    const f = path.join(tmp, "match.txt");
    fs.writeFileSync(f, "hello\n");
    const r = readbackVerify(f, "hello\n");
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.bytes, 6);
  });

  it("reports truncation when file is shorter than intended", () => {
    const f = path.join(tmp, "short.txt");
    fs.writeFileSync(f, "hello");
    const r = readbackVerify(f, "hello world");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /truncated/);
      assert.equal(r.expectedBytes, 11);
      assert.equal(r.actualBytes, 5);
    }
  });

  it("reports expansion when file is longer than intended (CRLF case)", () => {
    const f = path.join(tmp, "expanded.txt");
    // Simulate CRLF injection: we asked for LF, disk has CRLF.
    fs.writeFileSync(f, "a\r\nb\r\n");
    const r = readbackVerify(f, "a\nb\n");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /expanded/);
      assert.match(r.reason, /CRLF injection/);
    }
  });

  it("pinpoints byte offset on content mismatch (same length)", () => {
    const f = path.join(tmp, "swapped.txt");
    fs.writeFileSync(f, "hellO");
    const r = readbackVerify(f, "hello");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.firstDiffAt, 4);
      assert.match(r.reason, /byte 4/);
      assert.match(r.reason, /0x6f/); // expected 'o'
      assert.match(r.reason, /0x4f/); // got 'O'
    }
  });

  it("reports a read error when the file vanished between write and read", () => {
    const f = path.join(tmp, "ghost.txt");
    const r = readbackVerify(f, "content");
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /cannot re-read/);
  });
});

// ─── Layer 2: projectVerify ──────────────────────────────────────────────────

describe("projectVerify — Layer 2", () => {
  // All Layer 2 fixtures route through `node -e "<script>"` so they
  // work identically on Linux/macOS bash AND Windows cmd.exe. Earlier
  // versions used POSIX-only `printf`, `sleep`, `yes | head` and
  // failed on Windows CI with cryptic shell errors. Node is guaranteed
  // in PATH because we're already inside Node tests.
  function setVerifyCmd(script: string, timeoutMs = 30_000): void {
    // Outer double quotes survive both bash and cmd.exe unchanged;
    // inner single quotes are JS-only delimiters with no shell
    // meaning inside double quotes. Keep the script free of `$`,
    // backticks, and unescaped `%` to stay shell-neutral.
    const cmd = `node -e "${script}"`;
    setEngineConfig({
      ...DEFAULT_ENGINE_CONFIG,
      edit: { verifyCommand: cmd, verifyTimeoutMs: timeoutMs },
    });
  }

  it("skipped when no edit.verifyCommand configured", async () => {
    _resetEngineConfigForTests();
    const r = await projectVerify(tmp);
    assert.equal(r.outcome, "skipped");
    if (r.outcome === "skipped") assert.match(r.reason, /no edit.verifyCommand/);
  });

  it("ok when the configured command exits 0", async () => {
    setVerifyCmd("process.exit(0)");
    const r = await projectVerify(tmp);
    assert.equal(r.outcome, "ok");
  });

  it("failed with exit code on non-zero exit", async () => {
    setVerifyCmd("process.exit(1)");
    const r = await projectVerify(tmp);
    assert.equal(r.outcome, "failed");
    if (r.outcome === "failed") {
      assert.equal(r.exitCode, 1);
      assert.equal(r.timedOut, false);
    }
  });

  it("captures stderr in the output field", async () => {
    setVerifyCmd("process.stderr.write('compile error: missing semi\\n'); process.exit(2)");
    const r = await projectVerify(tmp);
    assert.equal(r.outcome, "failed");
    if (r.outcome === "failed") {
      assert.match(r.output, /compile error: missing semi/);
      assert.equal(r.exitCode, 2);
    }
  });

  it("times out when the command runs past verifyTimeoutMs", async () => {
    // setInterval keeps the event loop alive so the process won't
    // exit on its own — only the verify-runner timeout kill can stop
    // it. This also validates the Windows taskkill /F /T path: cmd.exe
    // spawns node.exe; killing only cmd.exe would orphan node and
    // keep the stdout/stderr pipes open, blocking 'close' for the
    // full duration of the inner command (5 s here).
    setVerifyCmd("setInterval(() => {}, 1000)", 200);
    const r = await projectVerify(tmp);
    assert.equal(r.outcome, "failed");
    if (r.outcome === "failed") {
      assert.equal(r.timedOut, true);
      assert.ok(r.durationMs >= 200, `expected ≥200ms, got ${r.durationMs}`);
      assert.ok(r.durationMs < 2_000, `expected <2s (early kill), got ${r.durationMs}`);
    }
  });

  it("caps captured output so a noisy verify doesn't blow tool_result", async () => {
    // 100 KB written to stdout via Node — bypasses cmd.exe's missing
    // `yes` / `head` builtins. `'x'.repeat(N)` works on every Node.
    setVerifyCmd("process.stdout.write('x'.repeat(100000)); process.exit(3)");
    const r = await projectVerify(tmp);
    assert.equal(r.outcome, "failed");
    if (r.outcome === "failed") {
      assert.match(r.output, /truncated at 8192 bytes/);
      assert.ok(r.output.length < 10_000, "output should be capped near 8KB");
    }
  });
});

// ─── renderVerifyReport composition ──────────────────────────────────────────

describe("renderVerifyReport", () => {
  it("returns empty string when both layers are null (verify=false)", () => {
    assert.equal(renderVerifyReport(null, null), "");
  });

  it("renders Layer 1 success terse + omits skipped Layer 2", () => {
    const out = renderVerifyReport(
      { ok: true, bytes: 100 },
      { outcome: "skipped", reason: "no edit.verifyCommand configured" },
    );
    assert.match(out, /write integrity OK \(100 bytes match\)/);
    assert.doesNotMatch(out, /skipped/);
    assert.doesNotMatch(out, /project check/);
  });

  it("renders Layer 1 failure with diagnosis + suggestion", () => {
    const out = renderVerifyReport(
      {
        ok: false,
        reason: "truncated: expected 100 bytes, on disk 80",
        expectedBytes: 100,
        actualBytes: 80,
        firstDiffAt: -1,
      },
      null,
    );
    assert.match(out, /WRITE INTEGRITY FAILED/);
    assert.match(out, /truncated/);
    assert.match(out, /WSL\/NTFS cache staleness/);
    assert.match(out, /retry/);
  });

  it("renders Layer 2 failure with exit code + output + advice", () => {
    const out = renderVerifyReport(
      { ok: true, bytes: 100 },
      {
        outcome: "failed",
        cmd: "npx tsc --noEmit",
        exitCode: 2,
        output: "src/foo.ts(45,10): error TS2304: Cannot find name 'x'.",
        durationMs: 1234,
        timedOut: false,
      },
    );
    assert.match(out, /project check FAILED \(npx tsc --noEmit, exit=2\)/);
    assert.match(out, /TS2304/);
    assert.match(out, /fix forward or revert/);
  });
});

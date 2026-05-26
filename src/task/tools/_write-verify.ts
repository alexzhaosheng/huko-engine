/**
 * server/task/tools/server/_write-verify.ts
 *
 * Two layers of "did the write actually land?" verification, used by
 * `write_file` and `edit_file` after `atomicWriteFileSync`:
 *
 *   LAYER 1 — readback (always-on when verify=true; default true)
 *     Re-read the file we just wrote, byte-compare against the buffer
 *     we INTENDED to write. Catches WSL/NTFS cache staleness,
 *     CRLF injection, NUL corruption, truncation. Cost: ~1ms on SSD
 *     for our 10 MiB cap; negligible.
 *
 *   LAYER 2 — project verify (opt-in via config.edit.verifyCommand)
 *     Spawn the operator-configured verify command (e.g. `npx tsc
 *     --noEmit`) with cwd = project root. Captures exit code + stderr.
 *     Subprocess timeout from config.edit.verifyTimeoutMs (default 30s).
 *
 * Both layers report STRUCTURED outcomes (`ok` / `failed` / `skipped`)
 * so the tool can compose a single user-facing message that names
 * which layer failed and why. Failure of either layer does NOT roll
 * back the write — atomic rename has already decided whether the file
 * is in its new state or old state; we trust that decision and surface
 * the diagnostics so the LLM can react.
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { getEngineConfig } from "../../config/state.js";

// ─── Layer 1: byte readback ──────────────────────────────────────────────────

export type ReadbackOk = { ok: true; bytes: number };
export type ReadbackFail = {
  ok: false;
  reason: string;
  expectedBytes: number;
  actualBytes: number;
  /** Byte offset of first divergence, or -1 if size mismatch. */
  firstDiffAt: number;
};
export type ReadbackResult = ReadbackOk | ReadbackFail;

/**
 * Re-read `absPath` and confirm its bytes equal the UTF-8 encoding of
 * `expected`. Any divergence → structured failure with a first-byte
 * pointer so callers can give the LLM a precise diagnosis ("truncated
 * at byte 1180", "byte 423 is 0x0D not 0x0A — likely CR injection").
 *
 * Read errors are also failures (the file vanished or perms changed
 * between our write and our read — same loud-failure contract).
 */
export function readbackVerify(absPath: string, expected: string): ReadbackResult {
  const expectedBuf = Buffer.from(expected, "utf8");

  let actual: Buffer;
  try {
    actual = readFileSync(absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `cannot re-read file after write: ${msg}`,
      expectedBytes: expectedBuf.length,
      actualBytes: -1,
      firstDiffAt: -1,
    };
  }

  if (actual.length !== expectedBuf.length) {
    return {
      ok: false,
      reason: actual.length < expectedBuf.length
        ? `truncated: expected ${expectedBuf.length} bytes, on disk ${actual.length}`
        : `expanded: expected ${expectedBuf.length} bytes, on disk ${actual.length} (CRLF injection or unexpected appending)`,
      expectedBytes: expectedBuf.length,
      actualBytes: actual.length,
      firstDiffAt: -1,
    };
  }

  if (!actual.equals(expectedBuf)) {
    let firstDiff = 0;
    while (firstDiff < actual.length && actual[firstDiff] === expectedBuf[firstDiff]) {
      firstDiff++;
    }
    const expectedByte = expectedBuf[firstDiff] ?? 0;
    const actualByte = actual[firstDiff] ?? 0;
    return {
      ok: false,
      reason:
        `content mismatch at byte ${firstDiff} ` +
        `(expected 0x${expectedByte.toString(16).padStart(2, "0")}, ` +
        `on disk 0x${actualByte.toString(16).padStart(2, "0")})`,
      expectedBytes: expectedBuf.length,
      actualBytes: actual.length,
      firstDiffAt: firstDiff,
    };
  }

  return { ok: true, bytes: actual.length };
}

// ─── Layer 2: project verify ────────────────────────────────────────────────

export type ProjectVerifyOk = {
  outcome: "ok";
  cmd: string;
  durationMs: number;
};
export type ProjectVerifyFailed = {
  outcome: "failed";
  cmd: string;
  exitCode: number | null;
  /** Combined stdout+stderr, capped to keep tool_result bounded. */
  output: string;
  durationMs: number;
  /** True when the failure was the timeout rather than a non-zero exit. */
  timedOut: boolean;
};
export type ProjectVerifySkipped = {
  outcome: "skipped";
  reason: string;
};
export type ProjectVerifyResult =
  | ProjectVerifyOk
  | ProjectVerifyFailed
  | ProjectVerifySkipped;

/** Cap on captured verify output so a noisy `tsc` doesn't blow the tool_result. */
const VERIFY_OUTPUT_CAP = 8 * 1024;

/**
 * Run the operator-configured verify command. Returns:
 *
 *   - `skipped`: no `config.edit.verifyCommand` set
 *   - `ok`:      command exited 0
 *   - `failed`:  non-zero exit OR timeout
 *
 * Command is run via shell so the operator can write `npx tsc
 * --noEmit && eslint .`-style chains without us building a parser.
 * cwd is `projectCwd` (the daemon's project root).
 */
export async function projectVerify(
  projectCwd: string,
  engineConfig?: { edit?: { verifyCommand?: string; verifyTimeoutMs?: number } },
): Promise<ProjectVerifyResult> {
  const cfg = engineConfig?.edit ?? getEngineConfig().edit;
  const cmd = cfg?.verifyCommand?.trim();
  if (!cmd || cmd.length === 0) {
    return { outcome: "skipped", reason: "no edit.verifyCommand configured" };
  }
  const timeoutMs = cfg?.verifyTimeoutMs ?? 30_000;

  const started = Date.now();
  return await new Promise<ProjectVerifyResult>((resolve) => {
    // `detached: true` puts the child (and its `sh -c …` subshell's
    // descendants) in a NEW process group. We can then SIGKILL the
    // whole group on timeout — without `detached`, signalling the
    // shell wrapper doesn't propagate to the actual `tsc` / `sleep`
    // / `pytest` it spawned, so the timeout would hang waiting for
    // a child that's still running.
    const child = spawn(cmd, {
      cwd: projectCwd,
      shell: true,
      detached: process.platform !== "win32",
      // Don't inherit stdin; some verify commands hang waiting for input.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buf = "";
    let truncated = false;
    let timedOut = false;

    const appendChunk = (chunk: Buffer): void => {
      if (truncated) return;
      const remaining = VERIFY_OUTPUT_CAP - buf.length;
      if (chunk.length <= remaining) {
        buf += chunk.toString("utf8");
      } else {
        buf += chunk.subarray(0, remaining).toString("utf8");
        truncated = true;
      }
    };

    child.stdout.on("data", appendChunk);
    child.stderr.on("data", appendChunk);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === "win32") {
          // Windows has no POSIX process groups. `child.kill()` alone
          // would only terminate the cmd.exe wrapper — its `node` /
          // `tsc` / `sleep` descendants would be orphaned, keep our
          // stdout/stderr pipes open, and prevent the 'close' handler
          // from firing (the timeout would wait the full duration of
          // the verify command, defeating its purpose). `taskkill
          // /F /T /PID <pid>` walks the process tree and force-kills
          // every descendant. Available on every Windows since XP,
          // ships in System32.
          if (child.pid !== undefined) {
            spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
              windowsHide: true,
              stdio: "ignore",
            });
          }
        } else if (child.pid !== undefined) {
          // Negative pid = whole process group (we made it the group
          // leader with detached: true). SIGKILL because verify
          // commands frequently ignore SIGTERM (sh forwards but doesn't
          // wait; tsc has its own handler that delays exit).
          process.kill(-child.pid, "SIGKILL");
        }
      } catch { /* already gone */ }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        outcome: "failed",
        cmd,
        exitCode: null,
        output: `spawn error: ${err.message}`,
        durationMs: Date.now() - started,
        timedOut: false,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const output = truncated
        ? buf + `\n…(verify output truncated at ${VERIFY_OUTPUT_CAP} bytes)`
        : buf;
      const durationMs = Date.now() - started;
      if (timedOut) {
        resolve({
          outcome: "failed",
          cmd,
          exitCode: code,
          output: output || `(no output before timeout @ ${timeoutMs}ms)`,
          durationMs,
          timedOut: true,
        });
        return;
      }
      if (code === 0) {
        resolve({ outcome: "ok", cmd, durationMs });
        return;
      }
      resolve({
        outcome: "failed",
        cmd,
        exitCode: code,
        output: output || "(no output)",
        durationMs,
        timedOut: false,
      });
    });
  });
}

// ─── Composition: human-readable verify report ───────────────────────────────

/**
 * Render the readback + project-verify outcomes into the trailing lines
 * appended to a `write_file` / `edit_file` tool_result. Returns an
 * empty string when verify was disabled entirely.
 *
 * Always-present format:
 *   [verify] write integrity OK (1234 bytes match)
 *   [verify] project check OK (npx tsc --noEmit, 412ms)
 *
 * Failure format (LLM-actionable):
 *   [verify] WRITE INTEGRITY FAILED
 *     ...
 *   [verify] project check FAILED (npx tsc --noEmit, exit=2)
 *     <captured output>
 */
export function renderVerifyReport(
  readback: ReadbackResult | null,
  project: ProjectVerifyResult | null,
): string {
  const lines: string[] = [];

  if (readback !== null) {
    if (readback.ok) {
      lines.push(`[verify] write integrity OK (${readback.bytes} bytes match)`);
    } else {
      lines.push(
        `[verify] WRITE INTEGRITY FAILED\n` +
        `  ${readback.reason}\n` +
        `  diagnosis: likely WSL/NTFS cache staleness, interrupted write, or external mutation.\n` +
        `  suggestion: re-read the file to see actual state; retry the edit — atomic write should land cleanly on retry.`,
      );
    }
  }

  if (project !== null) {
    switch (project.outcome) {
      case "skipped":
        // Don't surface "skipped" to the LLM — it's noise that just
        // reminds the operator they haven't configured verify yet.
        break;
      case "ok":
        lines.push(`[verify] project check OK (${project.cmd}, ${project.durationMs}ms)`);
        break;
      case "failed": {
        const tag = project.timedOut
          ? `timed out after ${project.durationMs}ms`
          : `exit=${project.exitCode ?? "null"}`;
        lines.push(
          `[verify] project check FAILED (${project.cmd}, ${tag})\n${project.output}\n` +
          `File was changed but does not verify. Decide whether to fix forward or revert.`,
        );
        break;
      }
    }
  }

  return lines.length > 0 ? "\n" + lines.join("\n") : "";
}

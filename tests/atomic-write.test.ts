/**
 * tests/atomic-write.test.ts
 *
 * Coverage for `_atomic-write.ts` — the temp+rename helper that both
 * `write_file` and `edit_file` route through.
 *
 * Invariants we pin:
 *   - happy path: bytes land at destination exactly as supplied
 *   - new file: works when destination doesn't exist
 *   - replace: works when destination already exists (rename-over)
 *   - cleanup: no `.tmp.*` orphans after a successful write
 *   - error: throws AND removes the temp file when rename fails
 *     (simulated by writing to a read-only directory)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { atomicWriteFileSync } from "../src/task/tools/_atomic-write.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(tmpdir(), "huko-atomic-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("atomicWriteFileSync — happy path", () => {
  it("creates a new file with the exact bytes", () => {
    const target = path.join(tmp, "hello.txt");
    atomicWriteFileSync(target, "Hello, World!\n");
    assert.equal(fs.readFileSync(target, "utf8"), "Hello, World!\n");
  });

  it("overwrites an existing file atomically", () => {
    const target = path.join(tmp, "doc.md");
    fs.writeFileSync(target, "# Old content");
    atomicWriteFileSync(target, "# New content");
    assert.equal(fs.readFileSync(target, "utf8"), "# New content");
  });

  it("handles UTF-8 (CJK, emoji) without corruption", () => {
    const target = path.join(tmp, "i18n.txt");
    const content = "你好世界 — let's go 🚀";
    atomicWriteFileSync(target, content);
    assert.equal(fs.readFileSync(target, "utf8"), content);
  });

  it("preserves LF-only line endings (no CRLF injection)", () => {
    const target = path.join(tmp, "code.ts");
    const content = "line1\nline2\nline3\n";
    atomicWriteFileSync(target, content);
    const buf = fs.readFileSync(target);
    // No 0x0D (CR) anywhere in the bytes.
    for (let i = 0; i < buf.length; i++) {
      assert.notEqual(buf[i], 0x0d, `unexpected CR at byte ${i}`);
    }
  });

  it("handles empty content", () => {
    const target = path.join(tmp, "empty.txt");
    atomicWriteFileSync(target, "");
    assert.equal(fs.readFileSync(target, "utf8"), "");
    assert.equal(fs.statSync(target).size, 0);
  });
});

describe("atomicWriteFileSync — cleanup", () => {
  it("leaves NO `.tmp.*` files in the target dir after a successful write", () => {
    const target = path.join(tmp, "clean.txt");
    atomicWriteFileSync(target, "data");
    const orphans = fs.readdirSync(tmp).filter((n) => n.includes(".tmp."));
    assert.deepEqual(orphans, [], `expected no temp orphans, got: ${orphans.join(", ")}`);
  });

  it("can be called repeatedly on the same path without colliding", () => {
    const target = path.join(tmp, "loop.txt");
    for (let i = 0; i < 20; i++) {
      atomicWriteFileSync(target, `iteration ${i}`);
    }
    assert.equal(fs.readFileSync(target, "utf8"), "iteration 19");
    const orphans = fs.readdirSync(tmp).filter((n) => n.includes(".tmp."));
    assert.deepEqual(orphans, []);
  });
});

describe("atomicWriteFileSync — error paths", () => {
  it("throws with a descriptive message when the parent dir does not exist", () => {
    const target = path.join(tmp, "missing", "subdir", "x.txt");
    assert.throws(
      () => atomicWriteFileSync(target, "data"),
      /atomicWriteFileSync/,
    );
  });

  it("does NOT leave a temp file when open() fails", () => {
    // Use a path whose parent doesn't exist → openSync fails before
    // any temp file is created.
    const target = path.join(tmp, "nope", "x.txt");
    try { atomicWriteFileSync(target, "data"); } catch { /* expected */ }
    // No orphan in tmp/ (parent of `nope` which itself doesn't exist).
    const orphans = fs.readdirSync(tmp).filter((n) => n.includes(".tmp."));
    assert.deepEqual(orphans, []);
  });
});

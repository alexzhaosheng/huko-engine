/**
 * server/task/tools/server/_atomic-write.ts
 *
 * Atomic file write — write-to-temp, fsync, rename. Used by
 * `write_file` and `edit_file` so an interrupted write (signal,
 * OOM, crashed editor process, WSL/9P hiccup) NEVER leaves the
 * destination half-written.
 *
 * Algorithm (POSIX-grade where the OS supports it):
 *
 *   1. `<file>.tmp.<pid>.<rand>` is opened with O_WRONLY|O_CREAT|O_EXCL
 *      in the SAME directory as the destination — required so rename
 *      stays atomic (rename across filesystems isn't atomic on POSIX).
 *   2. content is written, then fsync'd — kernel buffer pushed to disk.
 *   3. `rename(temp, dest)` — atomic on POSIX, atomic-on-success on
 *      modern Windows (Win10 1607+ with ReplaceFile semantics).
 *   4. parent dir fsync (POSIX only) — persists the rename itself.
 *
 * On any error the temp file is best-effort unlinked so we don't leave
 * `.tmp.*` orphans cluttering the project.
 *
 * Why not `fs.writeFileSync`: it's a single open/write/close with no
 * rename buffer. If the process dies between bytes 0 and N, the file
 * is now N bytes of partial content with the old content lost. This
 * actively bit huko users on Windows + WSL where the underlying 9P
 * cache can amplify interrupted-write damage. Atomic rename is the
 * standard fix and costs ~one extra syscall pair per write.
 */

import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

/**
 * Write `content` to `absPath` via temp + rename. Throws on any failure
 * AFTER best-effort cleanup of the temp file.
 *
 * The temp file is hidden (leading dot) and includes the writer's pid
 * + 6 random bytes so concurrent writers from this or another huko
 * process don't collide.
 */
export function atomicWriteFileSync(absPath: string, content: string): void {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const suffix = `.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  const tmpPath = path.join(dir, `.${base}${suffix}`);

  // O_WRONLY | O_CREAT | O_EXCL — if some other process has already
  // created our (very-randomised) temp name, fail loud rather than
  // overwrite. The retry contract is "the LLM tries the tool again",
  // which generates a new random suffix.
  let fd: number;
  try {
    fd = openSync(tmpPath, "wx");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`atomicWriteFileSync: cannot open temp ${tmpPath}: ${msg}`);
  }

  try {
    // writeSync(fd, string, position, encoding) variant — keeps us at
    // a single syscall for small/medium files. Large files (we cap at
    // 10 MiB elsewhere) still fit; Node loops the write internally.
    writeSync(fd, content, 0, "utf8");
    fsyncSync(fd);
  } catch (err) {
    safeCleanup(fd, tmpPath);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`atomicWriteFileSync: write/fsync failed for ${tmpPath}: ${msg}`);
  }
  closeSync(fd);

  try {
    renameSync(tmpPath, absPath);
  } catch (err) {
    // Rename failed — temp still exists. Drop it so we don't litter.
    try { unlinkSync(tmpPath); } catch { /* already gone */ }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`atomicWriteFileSync: rename ${tmpPath} → ${absPath} failed: ${msg}`);
  }

  // Parent-dir fsync persists the rename itself so a crash right after
  // doesn't lose the directory entry. POSIX-only — Windows' rename
  // already syncs the directory metadata. Some filesystems (FAT, some
  // WSL mounts) reject dir fsync with EINVAL; treat as non-fatal.
  if (process.platform !== "win32") {
    let dirFd: number | null = null;
    try {
      dirFd = openSync(dir, "r");
      fsyncSync(dirFd);
    } catch {
      // Best effort — the data is already on disk via the file fsync
      // above; only the directory entry is at risk, and most modern
      // filesystems durable-rename anyway.
    } finally {
      if (dirFd !== null) {
        try { closeSync(dirFd); } catch { /* ignore */ }
      }
    }
  }
}

function safeCleanup(fd: number, tmpPath: string): void {
  try { closeSync(fd); } catch { /* fd may already be closed */ }
  try { unlinkSync(tmpPath); } catch { /* already gone */ }
}

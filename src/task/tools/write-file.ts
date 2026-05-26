/**
 * Tool: write_file
 *
 * Overwrite (or create) a text file with new content. Auto-creates
 * the parent directory chain if needed.
 *
 * Cross-platform: Node's fs APIs handle path separators. We always
 * write UTF-8. Line endings are preserved as the LLM provided them
 * (we don't normalise to CRLF on Windows — git tooling typically
 * handles eol=auto, and forcing CRLF would break repos that pin LF).
 *
 * Limits:
 *   - Refuses to overwrite a directory.
 *   - Caps content at 10 MiB — anything bigger is almost certainly
 *     a mistake (logs, generated artefacts, base64 blobs).
 *   - No diff preview here. Use `read_file` first if you want to
 *     compare; or `edit_file` for surgical changes.
 */

import { mkdirSync, statSync } from "node:fs";
import * as path from "node:path";
import {
  MAX_FILE_BYTES,
  resolvePath,
  toPosixPath,
} from "./_fs-helpers.js";
import { atomicWriteFileSync } from "./_atomic-write.js";
import {
  projectVerify,
  readbackVerify,
  renderVerifyReport,
} from "./_write-verify.js";
import type { ServerToolDefinition, ServerToolHandler, ToolHandlerResult } from "./registry.js";
import { getEngineDefaultCwd } from "../../config/state.js";

const DESCRIPTION =
  "Write a UTF-8 text file. Overwrites the file if it exists; creates it (and any missing parent directories) if it doesn't. The on-disk write uses an atomic temp+rename so an interrupted write leaves the previous content intact.\n\n" +
  "<verify>\n" +
  "- By default the tool re-reads the file after writing and byte-compares against the intended content — catches CRLF injection, truncation, and stale-cache reads (notably on WSL/Windows). If your project has `edit.verifyCommand` configured, it also runs after the readback.\n" +
  "- Pass `verify: false` to skip both checks when verification overhead matters (e.g. batch-writing many small files).\n" +
  "</verify>\n\n" +
  "<instructions>\n" +
  "- For SURGICAL changes to existing files, prefer `edit_file` (find/replace). Use `write_file` for new files or full rewrites.\n" +
  "- Read the existing file first if you're rewriting — losing context is the #1 way to wreck working code.\n" +
  "- Line endings are preserved as you wrote them; the tool does not normalise CRLF/LF.\n" +
  "- Refuses paths that resolve to a directory or files larger than 10 MiB.\n" +
  "</instructions>";

export const writeFileDefinition: ServerToolDefinition = {
    name: "write_file",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path or path relative to cwd",
        },
        content: {
          type: "string",
          description: "The full file contents to write (UTF-8)",
        },
        verify: {
          type: "boolean",
          description:
            "Default true. When true, re-reads the file after writing and byte-compares against the intended content (Layer 1 — catches CRLF injection, truncation, WSL cache staleness), and runs `config.edit.verifyCommand` if set (Layer 2). Pass false to skip both.",
        },
      },
      required: ["path", "content"],
    },
    dangerLevel: "moderate",
  };

export const writeFileHandler: ServerToolHandler = async (args, ctx): Promise<ToolHandlerResult> => {
    const rawPath = String(args["path"] ?? "").trim();
    if (!rawPath) {
      return { content: "Error: `path` is required.", error: "missing path" };
    }
    const content = args["content"];
    if (typeof content !== "string") {
      return {
        content: "Error: `content` is required and must be a string.",
        error: "missing content",
      };
    }
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      return {
        content: `Error: content is ${Buffer.byteLength(content, "utf8")} bytes, exceeds ${MAX_FILE_BYTES} (10 MiB) cap.`,
        error: "content too large",
      };
    }

    const abs = resolvePath(rawPath);
    const display = toPosixPath(abs);

    // Refuse if path exists as a directory.
    try {
      const st = statSync(abs);
      if (st.isDirectory()) {
        return {
          content: `Error: ${display} is an existing directory; refusing to overwrite.`,
          error: "is directory",
        };
      }
    } catch {
      // doesn't exist — fine, we'll create it
    }

    // Auto-create parent dirs.
    try {
      mkdirSync(path.dirname(abs), { recursive: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: cannot create parent directory for ${display}: ${msg}`,
        error: "mkdir failed",
      };
    }

    try {
      atomicWriteFileSync(abs, content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: `Error: cannot write ${display}: ${msg}`,
        error: "write failed",
      };
    }

    // Verify (default on). Same two-layer composition as edit_file.
    const verify = args["verify"] !== false; // default true
    const readback = verify ? readbackVerify(abs, content) : null;
    const project = verify
      ? await projectVerify(
          ctx.cwd ?? ctx.engine?.defaultCwd ?? getEngineDefaultCwd(),
          ctx.engine?.config,
        )
      : null;
    const verifyReport = renderVerifyReport(readback, project);

    const writeFailed = readback !== null && !readback.ok;
    const projectFailed = project !== null && project.outcome === "failed";

    const lineCount = content.split(/\r?\n/).length;
    return {
      content:
        `${writeFailed ? "Wrote (with verify failure) " : "Wrote "}${display} — ${content.length} chars, ${lineCount} lines.` +
        verifyReport,
      summary: writeFailed
        ? `write_file ${display} (verify failed)`
        : `write_file ${display}`,
      ...(writeFailed ? { error: "readback verify failed" } : {}),
      ...(projectFailed && !writeFailed ? { error: "project verify failed" } : {}),
      metadata: {
        path: display,
        size: content.length,
        lines: lineCount,
        readbackOk: readback === null ? null : readback.ok,
        projectVerify: project === null ? null : project.outcome,
      },
    };
  };

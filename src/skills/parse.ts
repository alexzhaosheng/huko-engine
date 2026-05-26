/**
 * server/engine/skills/parse.ts
 *
 * Pure parsing functions for skill markdown files. No IO, no globals.
 * Takes raw file contents + the originating path (for diagnostics) and
 * returns the structured fields.
 *
 * Split out from the host-side loader so the same parsing logic can
 * power future non-filesystem skill sources (network-fetched packs,
 * test fixtures, in-memory authoring previews, etc.).
 */

import { parseYamlSubset } from "../util/yaml-frontmatter.js";
import type { SkillFrontmatter } from "./types.js";

/**
 * Split a `---\n...\n---` fence off the top of the file. If the file
 * has no fence, returns the whole content as the body.
 */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  // Normalise leading BOM + leading blank lines so `---` is recognised
  // even when the file was saved by an editor that injected a UTF-8 BOM.
  const cleaned = raw.replace(/^﻿/, "");
  if (!cleaned.startsWith("---")) {
    return { frontmatter: null, body: cleaned };
  }
  const lines = cleaned.split(/\r?\n/);
  // First line is the opening `---`; find the closing fence.
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    // Unclosed fence — treat the whole file as body so we don't lose content.
    return { frontmatter: null, body: cleaned };
  }
  const frontmatter = lines.slice(1, close).join("\n");
  const body = lines.slice(close + 1).join("\n");
  return { frontmatter, body };
}

export function parseFrontmatter(raw: string, srcPath: string): SkillFrontmatter {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYamlSubset(raw) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Skill frontmatter parse error in ${srcPath}: ${msg}`);
  }
  const out: SkillFrontmatter = {};
  if (typeof parsed["description"] === "string") {
    out.description = parsed["description"];
  }
  return out;
}

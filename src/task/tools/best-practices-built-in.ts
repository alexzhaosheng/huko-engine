/**
 * Built-in best-practices for the four foundational capabilities
 * (coding / writing / research / analysis) — engine-bundled, no IO.
 *
 * Analogous to `SqliteAgentPersistence`: a ready-to-use convenience
 * shipped in engine so hosts that don't have their own role / checklist
 * layer get sensible defaults out of the box. Install via:
 *
 *   createHukoEngine({
 *     persistence,
 *     hostHooks: { bestPracticesProvider: defaultBestPracticesProvider },
 *   });
 *
 * Each entry is a markdown body with optional YAML frontmatter. The
 * resolver pulls a `## Best Practices` section when present (lets the
 * file double as a longer persona doc + a concise checklist), or
 * falls back to the whole body capped at `DEFAULT_MAX_BODY_CHARS`.
 *
 * Hosts that want richer behaviour (project-local overrides via
 * `.huko/roles/<name>.md`, user-global overrides, custom registries)
 * compose with the building blocks here:
 *
 *   - `BUILT_IN_BEST_PRACTICES` — the raw map, read-only
 *   - `extractBestPracticesSection(body)` — pure section extractor
 *   - `resolveBestPracticeBody(raw, max?)` — full processing pipeline
 *     for a raw markdown body (strip frontmatter, prefer Best
 *     Practices section, cap length)
 *   - `resolveBuiltInBestPractice(name, max?)` — same, but pulls the
 *     raw from the bundled map
 *   - `formatBestPracticesInjection(phaseId, title, entries)` —
 *     compose the final string the plan tool appends to its
 *     tool_result
 *   - `defaultBestPracticesProvider` — the ready-to-use provider
 *
 * huko-cli wraps this provider with project + user filesystem layers
 * (see `huko-cli/src/task/best-practices.ts`).
 */

import type { BestPracticesProvider } from "./best-practices-provider.js";

/** Per-capability cap on body text (chars) — avoids context blowout. */
export const DEFAULT_MAX_BODY_CHARS = 1500;

/**
 * Map of capability name → raw markdown body (with frontmatter).
 * Read-only — hosts that need to extend should add a new entry via
 * their own provider, not mutate this map.
 */
export const BUILT_IN_BEST_PRACTICES: Readonly<Record<string, string>> = {

  // ─── coding ────────────────────────────────────────────────────────────────

  coding: `---
description: Best-practices for source code reading, editing, and review.
---

## Best Practices

- MUST read affected files end-to-end before patching; do NOT edit from incomplete context
- MUST follow existing conventions (naming, indentation, imports, comment density) — never impose your own style
- MUST run the project's type-check / tests after a substantive edit; "compiles in my head" is not done
- MUST make the smallest change that satisfies the requirement; do NOT refactor unrelated code while fixing a bug
- For shell commands, prefer non-interactive flags (\`-y\`, \`--yes\`, \`--no-input\`) and cap long-running commands with timeouts
- When summarising work done, bullet-list the changes file-by-file
- When reporting a problem, state what failed, where, and what you tried — before proposing fixes
- MUST NOT delete files, drop tables, force-push, or rewrite git history without explicit user approval
`,

  // ─── writing ───────────────────────────────────────────────────────────────

  writing: `---
description: Best-practices for technical documents and longer-form prose.
---

## Best Practices

- MUST save substantial pieces (more than ~10 lines) to a markdown file via \`write_file\`, NOT inline in chat
- MUST deliver final output as a file path via \`message(type=result)\`
- MUST default to GitHub-flavoured Markdown; use pipe tables, never raw HTML tables
- For technical writing: prose paragraphs as the body, NOT bullet-list-only output
- MUST hold to user-specified length, tone, audience, and format constraints
- MUST cite sources for non-common-knowledge factual claims; inline numeric citations with a reference list
- MUST NOT use emoji in professional documents
- For creative writing: maintain consistent tone, point of view, and tense across the piece
- Show, don't tell — concrete sensory details, dialogue, and action over abstract description
- Deliver one file per piece; do NOT split a single deliverable across multiple attachments
`,

  // ─── research ──────────────────────────────────────────────────────────────

  research: `---
description: Best-practices for multi-source investigation and synthesis.
---

## Best Practices

- MUST gather information from multiple independent sources; NEVER rely solely on internal knowledge
- MUST read multiple URLs from search results (use \`web_fetch\`) for cross-validation
- MUST save key findings to a notes file as you research — externalise before context compresses
- MUST include inline citations with source URLs for every factual claim in the final output
- MUST present balanced perspectives when the topic is debated or contested
- MUST clearly distinguish between established facts, expert opinions, and your own analysis
- For non-English topics, MUST include at least one English search variant for broader coverage
- MUST end the final document with a \`## Sources\` list, one annotated URL per entry
- MUST NOT fabricate quotes, URLs, dates, or statistics — if a source doesn't exist, say so
`,

  // ─── analysis ──────────────────────────────────────────────────────────────

  analysis: `---
description: Best-practices for tabular data analysis, summarisation, and visualisations.
---

## Best Practices

- MUST save analysis code to files (\`write_file\`) before running via \`bash\`; do NOT run multi-line analysis inline
- MUST validate data quality first — null counts, duplicate counts, types, outliers — before drawing conclusions
- MUST use pandas for tabular work; matplotlib / seaborn / plotly for visualisations
- MUST save plots as PNG files and attach the file paths in the result message
- MUST include clear axis labels, titles, and legends on every chart
- MUST quantify findings with sample size and units — never assert a trend without the numbers behind it
- MUST surface a "Limitations" paragraph: what the data doesn't cover, what assumptions you made
- MUST NOT fabricate data, statistics, or correlations — if the dataset is insufficient, state that as the finding
- For multi-file datasets, write one script that reads them all rather than chaining bash invocations
`,
};

// ─── Frontmatter stripping ──────────────────────────────────────────────────

/**
 * Strip a `---\\n...\\n---` fence off the top of a markdown body.
 * Tolerant of UTF-8 BOM. Returns the body unchanged when there's no
 * fence at the start.
 */
function stripFrontmatter(raw: string): string {
  const noBom = raw.startsWith("﻿") ? raw.slice(1) : raw;
  const openMatch = /^---[ \t]*\r?\n/.exec(noBom);
  if (!openMatch) return raw;
  const afterOpen = noBom.slice(openMatch[0].length);
  const closeMatch = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(afterOpen);
  if (!closeMatch) return raw;
  return afterOpen.slice(closeMatch.index + closeMatch[0].length);
}

// ─── Section extraction ─────────────────────────────────────────────────────

/**
 * Pull a `## Best Practices` section out of a body. Matches a level-2
 * heading whose text is "best practices" (case-insensitive), and
 * returns everything from the heading line up to (but excluding) the
 * next level-2 heading or end of body, trimmed.
 *
 * Returns null when no matching heading is present.
 */
export function extractBestPracticesSection(body: string): string | null {
  const re = /^##[ \t]+best practices\b.*$/im;
  const match = re.exec(body);
  if (!match) return null;

  const start = match.index;
  const tail = body.slice(start + match[0].length);
  const nextHeadingRe = /^##[ \t]+\S/m;
  const next = nextHeadingRe.exec(tail);
  const sectionRaw =
    next === null
      ? body.slice(start)
      : body.slice(start, start + match[0].length + next.index);
  return sectionRaw.trim();
}

// ─── Body processing pipeline ───────────────────────────────────────────────

/**
 * Given a raw markdown body (frontmatter optional), produce the
 * best-practice-shaped body to inject:
 *
 *   1. Strip YAML frontmatter (if present)
 *   2. Prefer the `## Best Practices` section
 *   3. Otherwise use the whole body
 *   4. Cap at `maxBodyChars`, with a truncation marker
 *
 * Returns null when the processed body is empty.
 */
export function resolveBestPracticeBody(
  raw: string,
  maxBodyChars: number = DEFAULT_MAX_BODY_CHARS,
): string | null {
  const body = stripFrontmatter(raw);
  const dedicated = extractBestPracticesSection(body);
  const source = dedicated ?? body;
  const trimmed = source.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= maxBodyChars) return trimmed;
  return trimmed.slice(0, maxBodyChars) + "\n…(truncated)";
}

/**
 * Resolve one capability against the engine-bundled map. Same
 * processing pipeline as `resolveBestPracticeBody`. Returns null when
 * the capability isn't bundled or yields an empty body.
 */
export function resolveBuiltInBestPractice(
  name: string,
  maxBodyChars: number = DEFAULT_MAX_BODY_CHARS,
): string | null {
  const raw = BUILT_IN_BEST_PRACTICES[name];
  if (raw === undefined) return null;
  return resolveBestPracticeBody(raw, maxBodyChars);
}

// ─── Final injection format ─────────────────────────────────────────────────

/**
 * Compose the final injection string the plan tool appends to its
 * tool_result. Takes pre-resolved (capability → body) entries and
 * renders the canonical header + per-capability blocks.
 *
 * Returns null when `entries` is empty so the plan tool can skip the
 * append entirely.
 */
export function formatBestPracticesInjection(
  phaseId: number,
  phaseTitle: string,
  entries: ReadonlyArray<{ name: string; body: string }>,
): string | null {
  if (entries.length === 0) return null;
  const blocks = entries.map(({ name, body }) => `[Role: ${name}]\n${body}`);
  return [
    `[Phase ${phaseId}: ${phaseTitle} — Expert Checklist]`,
    `The following best practices apply to this phase. Follow these guidelines:`,
    ``,
    blocks.join("\n\n"),
  ].join("\n");
}

// ─── Ready-to-use provider ──────────────────────────────────────────────────

/**
 * `BestPracticesProvider` that resolves capabilities ONLY against the
 * engine-bundled map. No filesystem, no host config. Install via the
 * engine constructor for hosts that want the four built-ins out of
 * the box with no extra wiring:
 *
 *   const engine = createHukoEngine({
 *     persistence,
 *     hostHooks: { bestPracticesProvider: defaultBestPracticesProvider },
 *   });
 *
 * Hosts that need filesystem / config overrides wrap this with their
 * own provider that tries IO first and falls back to
 * `resolveBuiltInBestPractice` per capability.
 */
export const defaultBestPracticesProvider: BestPracticesProvider = async (
  phaseId,
  phaseTitle,
  capabilities,
) => {
  if (!capabilities || capabilities.length === 0) return null;
  const entries: Array<{ name: string; body: string }> = [];
  for (const name of capabilities) {
    const body = resolveBuiltInBestPractice(name);
    if (body) entries.push({ name, body });
  }
  return formatBestPracticesInjection(phaseId, phaseTitle, entries);
};

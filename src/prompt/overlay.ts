/**
 * Prompt overlays — the host's mechanism for extending the canonical
 * engine system prompt.
 *
 * The engine assembles the base prompt (identity, scope, principles,
 * agent loop, tool use, error handling, safety, disclosure, skills,
 * project context, scheduled task, cache boundary). Hosts cannot
 * replace those — they can only INSERT additional content at one of
 * the defined positions.
 *
 * Three positions:
 *
 *   "after-skills"           — right after the operator skills block,
 *                              before project context. Use for host
 *                              skill-shaped material.
 *   "after-project-context"  — right after AGENTS.md / CLAUDE.md /
 *                              HUKO.md content. Use for host context
 *                              about the current product / app / page.
 *   "tail"                   — at the end of the cache-stable prefix,
 *                              just before the cache boundary +
 *                              current-date line. The default; matches
 *                              today's `extraOverlays: string[]` slot.
 *
 * All three positions sit INSIDE the prompt-cache-covered prefix —
 * overlays don't go before the agent-loop / tool-use blocks because
 * that would invalidate prompt cache across hosts sharing the base.
 *
 * Naming: each overlay carries a `name` for traceability (showing up
 * in debug renders, future cache-key derivation). The engine doesn't
 * use it for ordering — same-position overlays render in the order
 * they appear in the overlays array.
 */

export type OverlayPosition = "after-skills" | "after-project-context" | "tail";

export type PromptOverlay = {
  /** Stable identifier — debugging, tracing, prompt-cache invalidation. */
  name: string;
  /** Rendered overlay text. Engine inserts verbatim (after trim). */
  content: string;
  /** Where to insert. Defaults to "tail". */
  position?: OverlayPosition;
};

export const DEFAULT_OVERLAY_POSITION: OverlayPosition = "tail";

/**
 * Split an overlays array into the three position buckets. Used by
 * `assembleSystemPrompt` to insert at the right point in the canonical
 * order. Returns trimmed content strings; empty overlays are skipped.
 */
export function bucketOverlaysByPosition(
  overlays: readonly PromptOverlay[],
): Record<OverlayPosition, string[]> {
  const buckets: Record<OverlayPosition, string[]> = {
    "after-skills": [],
    "after-project-context": [],
    tail: [],
  };
  for (const overlay of overlays) {
    const trimmed = overlay.content.trim();
    if (trimmed.length === 0) continue;
    const position = overlay.position ?? DEFAULT_OVERLAY_POSITION;
    buckets[position].push(trimmed);
  }
  return buckets;
}

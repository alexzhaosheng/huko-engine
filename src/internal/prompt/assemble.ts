/**
 * server/engine/prompt/assemble.ts
 *
 * Top-level system-prompt assembler. Takes an already-resolved input —
 * skills loaded, project context read, scheduled-task / setup overlays
 * computed — and joins every block in the canonical order.
 *
 * The host's `buildSystemPrompt(opts)` does the IO (load skills, read
 * AGENTS.md, capture huko info, etc.) and calls this function with the
 * resolved input. Engine never reads files; the host always reads them.
 *
 * Composition order (kept stable for prefix-cache hits):
 *
 *   1. Identity preamble        — what huko IS (frontend-agnostic)
 *   2. <scope>                  — what huko CAN do; expertise menu
 *   3. <principles>             — universal conduct rules
 *   4. <language>
 *   5. <format>
 *   6. <agent_loop>
 *   7. <tool_use>               — generic baseline + per-tool promptHints
 *   8. <error_handling>
 *   9. <local>
 *  10. <safety>
 *  11. <disclosure_prohibition>
 *  12. <skills>                 — operator-authored skills (already loaded)
 *  13. <project_context>        — AGENTS.md / CLAUDE.md / HUKO.md (already read)
 *  14. <scheduled_task>         — when running cron-driven
 *  15. host extra overlays      — e.g. <setup_assistant> from huko-cli
 *  16. SYSTEM_PROMPT_CACHE_BOUNDARY + current-date line
 *
 * Why this order:
 *   - Stable framing at the top so prefix-cache hits cover it.
 *   - Operator overlays (skills, project_context, scheduled_task,
 *     setup_assistant) sit at the cache-stable tail of the prefix.
 *   - Volatile current-date line goes AFTER the cache boundary so the
 *     Anthropic prompt cache covers only the stable prefix.
 */

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../llm/cache-boundary.js";
import type { Skill } from "../../skills/types.js";
import {
  AGENT_LOOP_BLOCK,
  DISCLOSURE_BLOCK,
  ERROR_HANDLING_BLOCK,
  FORMAT_BLOCK,
  IDENTITY_LINE,
  PRINCIPLES_BLOCK,
  SAFETY_BLOCK,
  SCOPE_BLOCK,
  buildLanguageBlock,
  buildLocalBlock,
  buildToolUseBlock,
  formatCurrentDate,
  renderProjectContextBlock,
  renderScheduledTaskBlock,
  renderSkillsBlock,
  type ScheduledTaskInput,
} from "../../prompt/blocks.js";
import { bucketOverlaysByPosition, type PromptOverlay } from "../../prompt/overlay.js";

export type AssembleSystemPromptInput = {
  /** Project root — interpolated into `<local>`. */
  workingDirectory: string;
  /** Platform identifier reported in `<local>` (`process.platform` in huko-cli). */
  platform: string;
  /**
   * Working language pin, or null to let the LLM pick based on the
   * first user message.
   */
  workingLanguage?: string | null;
  /**
   * Wall-clock used for the cache-tail `The current date is ...` line.
   * Defaults to `new Date()` if omitted — but tests should pass a fixed
   * date for stability.
   */
  currentDate?: Date;
  /**
   * Per-tool prompt hints contributed by `ServerToolDefinition.promptHint`.
   * Host passes `getToolPromptHints(toolFilter)` so this list tracks the
   * tools actually visible to the LLM.
   */
  toolHints?: readonly string[];
  /**
   * Already-loaded operator skills. Host calls `loadActiveSkills` (file
   * IO) and passes the result through — engine never reads the
   * filesystem.
   */
  skills?: readonly Skill[];
  /**
   * Already-read project context (typically the concatenated contents of
   * AGENTS.md / CLAUDE.md / HUKO.md). Null when none of those files
   * exist or all are empty.
   */
  projectContext?: string | null;
  /** Cron framing + standing instructions; included when running scheduled. */
  scheduledTask?: ScheduledTaskInput;
  /**
   * Host-provided extra blocks rendered at the tail of the cache-stable
   * prefix (after project_context + scheduled_task). The host already
   * formatted these — e.g. huko-cli's `<setup_assistant>` overlay is
   * built in host code and passed through verbatim.
   *
   * Equivalent to `overlays` entries with `position: "tail"`. Kept as a
   * separate field for backwards compatibility with pre-facade hosts;
   * new code should pass structured `overlays` instead.
   */
  extraOverlays?: readonly string[];
  /**
   * Structured overlays with named placement at one of the three
   * canonical positions. See `./overlay.ts`. Hosts contributing host-
   * specific prompt material should reach for this rather than
   * `extraOverlays`.
   */
  overlays?: readonly PromptOverlay[];
};

/**
 * @internal — kernel primitive the facade wraps. New host code passes
 * skills / projectContext / overlays / scheduledTask through
 * `HukoAgent.startTurn(...)` (or `HukoAgentOptions`) and lets the
 * facade call this. Direct callers still work via the subpath import
 * (`@alexzhaosheng/huko-engine/prompt/assemble.js`) for engine tests
 * and pre-facade hosts.
 */
export function assembleSystemPrompt(input: AssembleSystemPromptInput): string {
  const parts: string[] = [];
  const buckets = bucketOverlaysByPosition(input.overlays ?? []);

  parts.push(IDENTITY_LINE);
  parts.push(SCOPE_BLOCK);
  parts.push(PRINCIPLES_BLOCK);
  parts.push(buildLanguageBlock(input.workingLanguage ?? null));
  parts.push(FORMAT_BLOCK);
  parts.push(AGENT_LOOP_BLOCK);
  parts.push(buildToolUseBlock(input.toolHints ?? []));
  parts.push(ERROR_HANDLING_BLOCK);
  parts.push(buildLocalBlock({ workingDirectory: input.workingDirectory, platform: input.platform }));
  parts.push(SAFETY_BLOCK);
  parts.push(DISCLOSURE_BLOCK);

  const skillsBlock = renderSkillsBlock(input.skills ?? []);
  if (skillsBlock) parts.push(skillsBlock);
  parts.push(...buckets["after-skills"]);

  if (input.projectContext && input.projectContext.length > 0) {
    parts.push(renderProjectContextBlock(input.projectContext));
  }
  parts.push(...buckets["after-project-context"]);

  if (input.scheduledTask) {
    parts.push(renderScheduledTaskBlock(input.scheduledTask));
  }

  // Legacy string overlays land at the same slot as structured tail
  // overlays. Order: legacy strings first (preserves today's output),
  // then structured tail overlays.
  for (const overlay of input.extraOverlays ?? []) {
    const trimmed = overlay.trim();
    if (trimmed.length === 0) continue;
    parts.push(trimmed);
  }
  parts.push(...buckets["tail"]);

  const date = formatCurrentDate(input.currentDate ?? new Date());
  parts.push(`${SYSTEM_PROMPT_CACHE_BOUNDARY}\nThe current date is ${date}.`);

  return parts.join("\n\n");
}

// Re-export the cache-boundary sentinel so host modules can find it
// through the engine prompt barrel rather than reaching into the LLM
// adapter contract.
export { SYSTEM_PROMPT_CACHE_BOUNDARY };

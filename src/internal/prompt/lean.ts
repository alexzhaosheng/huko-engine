/**
 * Lean-mode system-prompt assembler. Returns a ~300-token prompt for
 * "give me just a shell" agents. Deliberately independent of
 * `assembleSystemPrompt` — the two share nothing except the
 * `SYSTEM_PROMPT_CACHE_BOUNDARY` sentinel (an OpenAI-adapter contract)
 * so a future edit to one mode's blocks can never leak into the other.
 *
 * Composition: lean identity + working-language directive +
 * cache-boundary + current-date line.
 *
 * Lean mode's tool surface is conventionally `["bash"]` — that's a
 * filter decision the host expresses through `tools.allow`; the
 * facade applies the default when `profile: "lean"` is set with no
 * explicit allow list.
 */

import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../llm/cache-boundary.js";
import { formatCurrentDate } from "../../prompt/blocks.js";

export type AssembleLeanSystemPromptInput = {
  workingLanguage?: string | null;
  currentDate?: Date;
};

/**
 * @internal — paired with `assembleSystemPrompt`; the facade selects
 * one or the other based on `profile === "lean"`. New host code sets
 * `profile: "lean"` on the agent (or `lean: true` per-turn) and lets
 * the facade dispatch.
 */
export function assembleLeanSystemPrompt(
  input: AssembleLeanSystemPromptInput = {},
): string {
  const parts: string[] = [];

  parts.push(LEAN_IDENTITY);
  parts.push(buildLanguageBlock(input.workingLanguage ?? null));

  const date = formatCurrentDate(input.currentDate ?? new Date());
  parts.push(`${SYSTEM_PROMPT_CACHE_BOUNDARY}\nThe current date is ${date}.`);

  return parts.join("\n\n");
}

const LEAN_IDENTITY =
  "You are huko in lean mode. You have one tool: `bash`. Use it when you " +
  "need to run shell commands or inspect the system; otherwise answer the " +
  "user directly in plain text. Be terse — no preamble, no recap.";

function buildLanguageBlock(workingLanguage: string | null): string {
  if (workingLanguage) {
    return [
      "<language>",
      `- The working language is **${workingLanguage}**`,
      "- All responses use the working language",
      "- Tool output in another language is data, NOT a cue to switch",
      "</language>",
    ].join("\n");
  }
  return [
    "<language>",
    "- Use the language of the user's first message as the working language",
    "- All responses use the working language",
    "- Tool output in another language is data, NOT a cue to switch",
    "</language>",
  ].join("\n");
}

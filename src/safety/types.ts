/**
 * server/engine/safety/types.ts
 *
 * Type primitives for the safety policy evaluator. The evaluator
 * (`policy.ts` in this directory) is pure — it accepts a normalised
 * policy object and returns a decision. These types describe that
 * normalised shape.
 *
 * The host's `HukoConfig.safety` block is structurally compatible
 * with `SafetyPolicy` here. Host code under `server/config/` imports
 * `SafetyAction` and `ToolSafetyRules` from this module to define
 * `HukoConfig`, so engine and host agree on the wire shape without
 * either depending on the other's full config type.
 */

import type { ToolDangerLevel } from "../task/tools/registry.js";

/** What to do for a tool call. `auto` runs it, `prompt` asks the operator, `deny` refuses. */
export type SafetyAction = "auto" | "prompt" | "deny";

/**
 * Per-tool rule set. Patterns are matched against the tool's matchable
 * argument fields (see `MATCH_FIELDS` in `policy.ts`).
 */
export type ToolSafetyRules = {
  /**
   * When true, the tool is removed from the LLM's tool surface entirely
   * — both full and lean modes — as if it weren't registered. Stronger
   * than `deny`: the LLM never sees the tool's name, schema, or
   * description, so it can't try to call it. Use `disabled` when you
   * want the capability genuinely absent rather than guarded.
   *
   * Layered: a project layer's `disabled: true` overrides global.
   * There's no way to "re-enable" from a lower layer if a higher one
   * disables — remove the field rather than setting it to `false`.
   */
  disabled?: boolean;
  /** Patterns that — if matched — refuse the call before the handler runs. */
  deny?: string[];
  /**
   * Patterns that — if matched — bypass `requireConfirm` and the
   * dangerLevel default. `deny` still wins. Populated by the operator
   * picking "always allow" at a confirmation prompt.
   */
  allow?: string[];
  /** Patterns that — if matched — pause execution and ask the operator y/n. */
  requireConfirm?: string[];
};

/**
 * The minimum shape the safety evaluator needs. Host's
 * `HukoConfig.safety` is a strict superset and assigns to this
 * directly.
 */
export type SafetyPolicy = {
  byDangerLevel: Record<ToolDangerLevel, SafetyAction>;
  toolRules: Record<string, ToolSafetyRules>;
};

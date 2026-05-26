/**
 * server/services/features/runtime.ts
 *
 * `initFeatureRuntime` — the single seam where parsed config becomes
 * a LIVE runtime: tool visibility set, sidecars started (if asked).
 *
 * Why this exists: there used to be three callsites that all did
 *
 *     assertNoNameCollisionsWithTools(listToolNames());
 *     const enabled = computeEnabledFeatures(getEngineConfig().features);
 *     setEnabledFeatures(enabled);
 *     // ...then SOME of them also: await startEnabledSidecars(enabled, ...);
 *
 * one in `server/cli/bootstrap.ts` (CLI one-shot — no sidecars),
 * one in `server/cli/commands/chat.ts` (CLI chat — needs sidecars),
 * one in `server/core/app.ts` `startDaemon` (daemon — needs sidecars).
 *
 * The daemon path forgot the sidecar step, so `huko daemon start
 * --enable=browser-control` flipped the tool visibility but never
 * spun up the WebSocket listener the Chrome extension needed.
 * Indistinguishable from "enabled" until you tried to use it.
 *
 * Folding all three into one call site means a future feature with a
 * sidecar gets wired into every entry point automatically — there's
 * no "I forgot to add the start in mode X" bug to make.
 *
 * Sidecar lifecycle is still the caller's responsibility on the
 * shutdown side: `stopAllSidecars()` is exported from this barrel
 * for the same callers that pass `startSidecars: true`.
 */

import { getEngineConfig } from "../config/state.js";
import { listToolNames, setEnabledFeatures } from "../task/tools/registry.js";
import {
  assertNoNameCollisionsWithTools,
  computeEnabledFeatures,
} from "./registry.js";
import { startEnabledSidecars, type StartResult } from "./sidecars.js";

export type InitFeatureRuntimeOptions = {
  /** Where sidecars should anchor any project-local resources. Only
   *  consulted when `startSidecars: true`. */
  projectRoot: string;
  /**
   * Spin up sidecars for every feature whose registration includes one
   * AND that ends up in the enabled set. Pass `false` for one-shot
   * CLI runs (the process exits before any sidecar would matter);
   * pass `true` for long-lived processes (chat REPL, daemon).
   *
   * NOT idempotent — the same sidecar must not be started twice
   * without an intervening `stopAllSidecars`. Callers responsible
   * for shutdown.
   */
  startSidecars: boolean;
};

export type InitFeatureRuntimeResult = {
  /** Names of every feature in the enabled set. */
  enabledFeatures: Set<string>;
  /** Sidecar start outcomes. `null` when `startSidecars: false`. */
  sidecarStart: StartResult | null;
};

/**
 * Run the post-loadConfig wiring exactly once for a runtime.
 *
 * Pre-condition: `loadConfig()` has been called for this process so
 * `getEngineConfig().features` reflects the merged config layers (user +
 * project + explicit CLI overrides).
 *
 * Returns the resolved enabled set so callers can render banners /
 * write logs / decide downstream behaviour, plus the sidecar start
 * result so callers can report per-sidecar failures in whatever way
 * fits their UX (CLI prints yellow warnings; daemon writes stderr).
 */
export async function initFeatureRuntime(
  opts: InitFeatureRuntimeOptions,
): Promise<InitFeatureRuntimeResult> {
  assertNoNameCollisionsWithTools(listToolNames());
  const enabledFeatures = computeEnabledFeatures(getEngineConfig().features);
  setEnabledFeatures(enabledFeatures);
  const sidecarStart = opts.startSidecars
    ? await startEnabledSidecars(enabledFeatures, { projectRoot: opts.projectRoot })
    : null;
  return { enabledFeatures, sidecarStart };
}

/**
 * server/engine/config/state.ts
 *
 * Process-wide engine-config holder. The host calls `setEngineConfig`
 * at boot — typically right after `loadConfig()` produces the HukoConfig
 * — and engine code reads from `getEngineConfig()` thereafter.
 *
 * Engine modules use this in place of host's `getConfig()` so they
 * don't import host-side config code. Host's `loadConfig` keeps its
 * existing global; this engine-side state is a separate copy the host
 * pushes in, so engine can be embedded by a different product (with a
 * different overall config object) without touching engine.
 *
 * Tests reset via `_resetEngineConfigForTests()`.
 */

import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "./types.js";

/**
 * Initialised to DEFAULT_ENGINE_CONFIG so tests and other unloaded
 * callers see something sensible without having to wire host's
 * loadConfig() into every fixture. Production hosts push in their
 * resolved config via `setEngineConfig` right after `loadConfig()`.
 */
let current: EngineConfig = DEFAULT_ENGINE_CONFIG;

export function setEngineConfig(c: EngineConfig): void {
  current = c;
}

export function getEngineConfig(): EngineConfig {
  return current;
}

/** Test-only: reset to engine defaults. */
export function _resetEngineConfigForTests(): void {
  current = DEFAULT_ENGINE_CONFIG;
}

// ─── Engine default cwd (host-injected) ─────────────────────────────────────
//
// Engine code must not read `process.cwd()` directly — that ties the
// engine to a particular Node process. Instead the host pushes the
// "default working directory" once at boot via `setEngineDefaultCwd`,
// and engine tools (bash, glob, grep, …) fall back to it when neither
// the call's args nor `TaskContext.cwd` supplies one.
//
// Default `"."` so tests that never call `setEngineDefaultCwd` still
// get a valid relative path that Node's spawn / fs treat as the
// current process cwd — same observable behaviour as the previous
// `process.cwd()` fallback, just resolved by Node at the syscall edge
// instead of by engine code.

const DEFAULT_CWD = ".";
let injectedCwd: string = DEFAULT_CWD;

export function setEngineDefaultCwd(cwd: string): void {
  injectedCwd = cwd;
}

export function getEngineDefaultCwd(): string {
  return injectedCwd;
}

/** Test-only: reset to the engine's "." fallback. */
export function _resetEngineDefaultCwdForTests(): void {
  injectedCwd = DEFAULT_CWD;
}

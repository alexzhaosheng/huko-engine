/**
 * server/engine/config/types.ts
 *
 * The subset of huko's configuration the engine consumes.
 *
 * The host's full `HukoConfig` (server/config/types.ts) is a structural
 * superset — it has every field this type requires plus host-only
 * fields (cli, daemon, browser, skills, etc.). Assigning a HukoConfig
 * value to an EngineConfig parameter just works through TypeScript
 * structural subtyping; no adapter / projector required.
 *
 * Engine code reads from this via `getEngineConfig()` (state.ts) after
 * the host has called `setEngineConfig(hukoConfig)` at boot.
 */

import type { SafetyPolicy } from "../safety/types.js";

// ─── Compaction primitives (moved from server/config/types.ts) ──────────────

/**
 * Five presets + "max" mapping to absolute target-token counts the
 * compactor aims for. Resolver in `./compaction.ts` clamps the preset's
 * absolute target against the active model's context window so small
 * windows degrade to "as much as fits".
 */
export type CompactionLevel = "concise" | "standard" | "extended" | "large" | "max";

export const COMPACTION_LEVEL_TARGETS: Record<Exclude<CompactionLevel, "max">, number> = {
  concise: 32_000,
  standard: 64_000,
  extended: 128_000,
  large: 256_000,
};

export const COMPACTION_LEVELS: readonly CompactionLevel[] = [
  "concise",
  "standard",
  "extended",
  "large",
  "max",
] as const;

// ─── EngineConfig ───────────────────────────────────────────────────────────

export type EngineConfig = {
  mode: "full" | "lean";

  task: {
    maxIterations: number;
    maxToolCalls: number;
    maxEmptyRetries: number;
    /** Abort an LLM call if no stream chunk arrives in this many ms. */
    llmIdleTimeoutMs: number;
  };

  compaction: {
    level: CompactionLevel;
    thresholdRatio?: number;
    targetRatio?: number;
    charsPerToken: number;
  };

  edit: {
    verifyCommand?: string;
    verifyTimeoutMs: number;
  };

  tools: {
    webFetch: { maxBytes: number; timeoutMs: number };
    webSearch: {
      provider: "duckduckgo";
      timeoutMs: number;
      maxResults: number;
    };
  };

  safety: SafetyPolicy;

  features: Record<string, { enabled?: boolean }>;
};

/**
 * Built-in engine defaults. Used by `getEngineConfig()` when the host
 * hasn't pushed in a config yet — keeps tests and unloaded callers
 * working without making the engine reach into host's loader.
 *
 * Host's `DEFAULT_CONFIG` (server/config/types.ts) is a strict
 * superset; the values here MUST stay in sync for the engine-eligible
 * fields. If they drift, the test
 * `tests/engine-default-config-matches-host.test.ts` (TODO add)
 * catches it.
 */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  mode: "full",
  task: {
    maxIterations: 200,
    maxToolCalls: 200,
    maxEmptyRetries: 3,
    llmIdleTimeoutMs: 300_000,
  },
  compaction: {
    level: "standard",
    charsPerToken: 4,
  },
  edit: {
    verifyTimeoutMs: 30_000,
  },
  tools: {
    webFetch: {
      maxBytes: 1 * 1024 * 1024,
      timeoutMs: 20_000,
    },
    webSearch: {
      provider: "duckduckgo",
      timeoutMs: 15_000,
      maxResults: 10,
    },
  },
  safety: {
    byDangerLevel: {
      safe: "auto",
      moderate: "prompt",
      dangerous: "prompt",
    },
    toolRules: {},
  },
  features: {},
};

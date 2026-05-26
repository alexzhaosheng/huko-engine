/**
 * Engine-side factory for the 13 foundational tools (bash, glob, grep,
 * list-dir, read-file, write-file, edit-file, delete-file, move-file,
 * plan, message, web-fetch, web-search).
 *
 * Two consumption shapes:
 *
 *   1. `FOUNDATIONAL_TOOL_REGISTRATIONS` — a `readonly` array of
 *      `EngineToolRegistration` objects. The facade-shaped value hosts
 *      pass directly to `engine.registerTool({...})`.
 *
 *   2. `registerFoundationalTools(engine)` — convenience that loops
 *      the array onto an engine instance. Use during host bootstrap.
 *
 * Mirrors the SqliteAgentPersistence / defaultBestPracticesProvider
 * pattern: foundational behaviour shipped as a per-instance opt-in
 * rather than a process-global side effect.
 *
 * For the legacy global-registry path (huko-cli's bare
 * `getToolsForLLM` consumers, a few tests), `task/tools/index.ts`
 * still side-effect-registers the same set into the global. Both
 * paths can coexist in one process; the engine's `resolveTool` falls
 * back to the global, so even an engine that wasn't fed the factory
 * sees foundational tools via the global fallback.
 */

import type { HukoEngine } from "../../facade.js";
import type {
  EngineToolRegistration,
} from "../../facade.js";

import { registerServerTool, getTool } from "./registry.js";

import { messageDefinition, messageHandler } from "./message.js";
import { planDefinition, planHandler } from "./plan.js";
import { webFetchDefinition, webFetchHandler } from "./web-fetch.js";
import { webSearchDefinition, webSearchHandler } from "./web-search.js";
import { readFileDefinition, readFileHandler } from "./read-file.js";
import { listDirDefinition, listDirHandler } from "./list-dir.js";
import { globDefinition, globHandler } from "./glob.js";
import { grepDefinition, grepHandler } from "./grep.js";
import { writeFileDefinition, writeFileHandler } from "./write-file.js";
import { editFileDefinition, editFileHandler } from "./edit-file.js";
import { deleteFileDefinition, deleteFileHandler } from "./delete-file.js";
import { moveFileDefinition, moveFileHandler } from "./move-file.js";
import { bashDefinition, bashHandler } from "./bash.js";

/**
 * All foundational tools as `EngineToolRegistration` records. Order
 * matches the legacy side-effect import in `task/tools/index.ts`, so
 * promptHint ordering in the system prompt is identical when this
 * factory replaces the side-effect path.
 */
export const FOUNDATIONAL_TOOL_REGISTRATIONS: readonly EngineToolRegistration[] = [
  { ...messageDefinition, handler: messageHandler },
  { ...planDefinition, handler: planHandler },
  { ...webFetchDefinition, handler: webFetchHandler },
  { ...webSearchDefinition, handler: webSearchHandler },
  { ...readFileDefinition, handler: readFileHandler },
  { ...listDirDefinition, handler: listDirHandler },
  { ...globDefinition, handler: globHandler },
  { ...grepDefinition, handler: grepHandler },
  { ...writeFileDefinition, handler: writeFileHandler },
  { ...editFileDefinition, handler: editFileHandler },
  { ...deleteFileDefinition, handler: deleteFileHandler },
  { ...moveFileDefinition, handler: moveFileHandler },
  { ...bashDefinition, handler: bashHandler },
];

/**
 * Register every foundational tool onto a `HukoEngine` instance.
 * Idempotent only when called once per engine — engine.registerTool
 * throws on duplicate names within an instance.
 *
 * Typical bootstrap order in the host:
 *
 *   const engine = createHukoEngine({ persistence, hostHooks });
 *   registerFoundationalTools(engine);
 *   engine.registerTool({ name: "my_host_tool", ... });
 */
export function registerFoundationalTools(engine: HukoEngine): void {
  for (const reg of FOUNDATIONAL_TOOL_REGISTRATIONS) {
    engine.registerTool(reg);
  }
}

/**
 * Register every foundational tool into the process-global registry.
 * Idempotent: skips tools already present (lets tests / multiple
 * hosts call this safely).
 *
 * Use this when a host has code paths that read the global registry
 * directly (cli's legacy `getTool` / `getToolsForLLM` consumers) and
 * needs the 13 tools populated before those paths run. Hosts that
 * only work through engine instances do NOT need this — engine.registerTool
 * + the resolveTool global fallback covers them.
 */
export function registerFoundationalToolsGlobally(): void {
  for (const reg of FOUNDATIONAL_TOOL_REGISTRATIONS) {
    if (getTool(reg.name) === undefined) {
      const { handler, ...definition } = reg;
      registerServerTool(definition, handler);
    }
  }
}

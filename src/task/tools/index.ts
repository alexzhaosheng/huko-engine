/**
 * Engine-side aggregator that registers EVERY foundational tool into
 * the process-global tool registry. Importing this module triggers all
 * registrations as a side effect.
 *
 * The 13 foundational tools (bash, glob, grep, list-dir, read-file,
 * write-file, edit-file, delete-file, move-file, plan, message,
 * web-fetch, web-search) are engine code; this file is the single
 * place that says "register them all." Hosts that want all of them
 * available do:
 *
 *   import "@alexzhaosheng/huko-engine/task/tools/index.js";
 *
 * Per-instance hosts (app-studio, post-step-6 cli) also get them via
 * the facade's `engine.resolveTool` global fallback — no host code
 * has to import this aggregator explicitly unless it wants the global
 * registry populated (some tests do; cli's bootstrap does, for
 * back-compat with the pre-facade getToolsForLLM consumers).
 */

import { registerServerTool } from "./registry.js";

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

registerServerTool(messageDefinition, messageHandler);
registerServerTool(planDefinition, planHandler);
registerServerTool(webFetchDefinition, webFetchHandler);
registerServerTool(webSearchDefinition, webSearchHandler);
registerServerTool(readFileDefinition, readFileHandler);
registerServerTool(listDirDefinition, listDirHandler);
registerServerTool(globDefinition, globHandler);
registerServerTool(grepDefinition, grepHandler);
registerServerTool(writeFileDefinition, writeFileHandler);
registerServerTool(editFileDefinition, editFileHandler);
registerServerTool(deleteFileDefinition, deleteFileHandler);
registerServerTool(moveFileDefinition, moveFileHandler);
registerServerTool(bashDefinition, bashHandler);

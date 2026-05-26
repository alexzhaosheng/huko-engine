/**
 * Persistence subpath barrel.
 *
 * Hosts import from `@alexzhaosheng/huko-engine/persistence/index.js`
 * (or via the package barrel once it re-exports this). The two
 * built-in implementations + the interface live here; nothing else.
 *
 * The pre-existing `./types.ts` holds the larger `SessionPersistence`
 * surface that huko-cli's ORM-style layer extends; that's NOT
 * exported through here — it's cli-product detail, reachable via
 * its own subpath if needed.
 */

export type {
  AgentPersistence,
  CreateSessionInput,
  CreateTaskInput,
  UpdateTaskPatch,
} from "./agent-persistence.js";

export { MemoryAgentPersistence } from "./memory.js";
export { SqliteAgentPersistence } from "./sqlite.js";

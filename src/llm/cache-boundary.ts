/**
 * server/engine/llm/cache-boundary.ts
 *
 * Zero-width sentinel inserted into the system prompt to mark where
 * Anthropic-style ephemeral cache breakpoints fall. The Anthropic
 * adapter consumes the sentinel to emit `cache_control` markers on the
 * surrounding content block; other adapters (OpenAI etc.) strip it so
 * it never reaches the wire.
 *
 * Lives in engine/llm/ rather than the prompt builder because every
 * adapter has to agree on the marker's exact characters — it's part of
 * the LLM adapter contract, not a prompt-builder internal. The prompt
 * builder just inserts it; the adapters interpret it.
 */
export const SYSTEM_PROMPT_CACHE_BOUNDARY = "​<<CACHE_BOUNDARY>>​";

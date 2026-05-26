/**
 * server/engine/skills/active.ts
 *
 * Pure helper that reads the user's `config.skills` map and returns
 * the sorted list of skill names the operator has marked enabled.
 * Sorting is stable so system-prompt rendering caches cleanly.
 */

/**
 * Return the set of skill names currently active per `config.skills`.
 * Sorted for stable system-prompt rendering (cache-friendly).
 */
export function activeSkillNames(
  skillsConfig: Record<string, { enabled?: boolean }> | undefined,
): string[] {
  if (!skillsConfig) return [];
  const out: string[] = [];
  for (const [name, entry] of Object.entries(skillsConfig)) {
    if (entry && entry.enabled === true) out.push(name);
  }
  out.sort();
  return out;
}

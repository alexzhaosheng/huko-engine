/**
 * server/engine/task/tools/best-practices-provider.ts
 *
 * Engine-side seam for "the plan tool just activated a new phase;
 * inject the matching role's best-practices into the tool_result."
 * The actual lookup walks `~/.huko/roles/` + `<cwd>/.huko/roles/`
 * + the built-in role table, which is host concern (file IO, host
 * config layers).
 *
 * Host installs the lookup at boot via `setBestPracticesProvider`.
 * If no host installs one, `invokeBestPracticesProvider` returns null
 * — the plan tool runs unchanged, just without role-flavoured advice.
 */

export type BestPracticesProvider = (
  phaseId: number,
  phaseTitle: string,
  capabilities: string[] | undefined,
  cwd?: string,
) => Promise<string | null>;

let provider: BestPracticesProvider | null = null;

export function setBestPracticesProvider(fn: BestPracticesProvider | null): void {
  provider = fn;
}

export async function invokeBestPracticesProvider(
  phaseId: number,
  phaseTitle: string,
  capabilities: string[] | undefined,
  cwd?: string,
): Promise<string | null> {
  if (!provider) return null;
  try {
    return await provider(phaseId, phaseTitle, capabilities, cwd);
  } catch {
    return null;
  }
}

/** Test-only: clear the installed provider. */
export function _resetBestPracticesProviderForTests(): void {
  provider = null;
}

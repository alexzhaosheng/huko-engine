/**
 * server/engine/safety/rule-persister.ts
 *
 * Engine-side seam for "operator clicked 'always allow' on a tool call,
 * persist that decision back to the config file." The actual write is
 * a host concern (it knows about `~/.huko/config.json` /
 * `<cwd>/.huko/config.json` paths and file IO); engine only needs to
 * trigger it.
 *
 * Host installs the writer at boot via `setSafetyRulePersister`. If
 * no host installs one (e.g. embedded test, future product without
 * file-based safety storage), `invokeSafetyRulePersister` is a no-op
 * — the tool still runs, the rule just isn't durable.
 */

export type SafetyRuleScope = "global" | "project";

export type SafetyRulePersister = (
  scope: SafetyRuleScope,
  /** The cwd to scope a project-layer rule to. Ignored when scope === "global". */
  cwd: string,
  toolName: string,
  bucket: "deny" | "allow" | "requireConfirm",
  pattern: string,
) => void;

let persister: SafetyRulePersister | null = null;

export function setSafetyRulePersister(fn: SafetyRulePersister | null): void {
  persister = fn;
}

/**
 * Forward to the host-installed persister. Catches any error the
 * persister throws — durable rule storage is a "nice to have"; tool
 * execution must not break because a config file write failed.
 */
export function invokeSafetyRulePersister(
  scope: SafetyRuleScope,
  cwd: string,
  toolName: string,
  bucket: "deny" | "allow" | "requireConfirm",
  pattern: string,
): void {
  if (!persister) return;
  try {
    persister(scope, cwd, toolName, bucket, pattern);
  } catch {
    /* persister error is non-fatal */
  }
}

/** Test-only: clear the installed persister. */
export function _resetSafetyRulePersisterForTests(): void {
  persister = null;
}

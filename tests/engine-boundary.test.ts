/**
 * tests/engine-boundary.test.ts
 *
 * Enforces the engine / host split. Every TypeScript file inside the
 * `@alexzhaosheng/huko-engine` package (`src/`)
 * is held to a strict import contract:
 *
 *   - allowed: `node:*`, packages declared in the engine package's
 *     `package.json`, other files inside the engine package
 *   - forbidden: anything else (relative paths back to the cli, e.g.
 *     `../../../server/...`, or bare imports for packages the engine
 *     doesn't declare a dependency on)
 *
 * Plus a separate check for `process.cwd()` usage — engine code must
 * accept a `workingDirectory` parameter from the host instead of
 * silently reading the current process cwd.
 *
 * After the monorepo split (PR #110 + this PR), the engine boundary
 * is ALSO enforced by package-level mechanisms (a missing dep in
 * `package.json` fails resolution at install +
 * build time). This walker is the belt-and-braces second line; the
 * plan keeps it for two release cycles before re-evaluating.
 *
 * Why a vanilla node:test instead of an eslint rule:
 *   keeps it self-contained, zero-config, no plugin author dance.
 *   The check is cheap (regex over a few files) so it runs alongside
 *   every other test.
 *
 * Limitations (acceptable for step 1):
 *   - import extraction uses regex, not the TypeScript AST. Comments
 *     are stripped first to avoid false positives on commented-out
 *     imports, but a string literal containing `from "..."` could
 *     in principle trigger a false positive. Engine code shouldn't
 *     have such literals in practice.
 *   - `process.cwd()` check is a literal regex — code that aliases
 *     `process` or imports `node:process` and calls `.cwd()` through
 *     the alias slips through. We can tighten this in a later step
 *     if real engineers find a way to be cute about it.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Paths ──────────────────────────────────────────────────────────────────

// This test file lives at tests/engine-boundary.test.ts. The engine
// package root is one level up.
const ENGINE_PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const ENGINE_ROOT = path.join(ENGINE_PKG_ROOT, "src");
/**
 * Engine's shared/ folder now lives INSIDE the engine package (was at
 * repo root before the monorepo split). Engine code may import from it
 * freely — it's part of the same package, just kept as a separate
 * directory because the types are also re-exported as the engine's
 * public types surface for consumers like the web frontend.
 */
const SHARED_ROOT = path.join(ENGINE_ROOT, "shared");

// ─── Allowed third-party deps (from engine's own package.json) ─────────────
//
// Reading the ENGINE package's deps (not the root cli's) so that a careless
// engine import of a cli-only package fails the test. The root's
// devDependencies (vitest, react, etc.) must NOT be reachable from engine.

const pkgJson = JSON.parse(
  readFileSync(path.join(ENGINE_PKG_ROOT, "package.json"), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const allowedDeps = new Set<string>([
  ...Object.keys(pkgJson.dependencies ?? {}),
  ...Object.keys(pkgJson.devDependencies ?? {}),
  ...Object.keys(pkgJson.peerDependencies ?? {}),
  ...Object.keys(pkgJson.optionalDependencies ?? {}),
]);

// ─── Legacy allowlist ──────────────────────────────────────────────────────
//
// Pre-existing files inside the engine package that import from
// neighbours that haven't been migrated yet. Each entry below is a
// tolerated violation tied to a planned migration step. The test
// fails on any NEW violation; the allowlist shrinks as later PRs
// land.
//
// Format: `<importer-relative-to-repo>::<import-specifier>`.
//
// REMOVE entries from this set as the corresponding source modules get
// integrated into the engine package. The test will start failing if
// any LISTED entry no longer applies (no orphan whitelist drift).

const ALLOWED_LEGACY: ReadonlySet<string> = new Set([
  // (empty) — every import violation has been retired. Add an entry
  // here only when a new sub-step lands a known temporary regression
  // it plans to fix in a follow-up; otherwise fix the violation in the
  // same PR that introduced it.
]);

/**
 * Files allowed to read `process.cwd()` as a fallback during step 4 /
 * step 5 of the migration. The foundational tool implementations
 * historically use cwd as a default base for path resolution; the
 * proper engine pattern is to receive the working directory through
 * the tool execution context (TaskContext.cwd) rather than reading
 * process state.
 *
 * Step 5 / step 6 thread cwd through the tool call boundary and these
 * entries get deleted.
 */
const ALLOWED_LEGACY_CWD_READERS: ReadonlySet<string> = new Set([
  // (empty) — engine code no longer reads process.cwd() directly.
  // Host installs the engine's idea of "default cwd" via
  // setEngineDefaultCwd(); tools fall back to getEngineDefaultCwd()
  // when ctx.cwd / args.cwd aren't supplied.
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTs(p));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Strip both block and line comments so the import-extracting regex
 * doesn't fire on commented-out imports. Naive — a `// foo` inside a
 * string literal also gets stripped — but for the purpose of this
 * test that's acceptable (would only mask, not falsely flag, a
 * violation).
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Tolerates string literals while tracking block comments. The naive
 * strip above gets fooled by a closing block-comment sentinel sitting
 * inside a string — e.g. a tool's description string containing a glob
 * pattern with star-slash. This scanner only enters block-comment mode
 * when the open sequence appears outside a string, which is good
 * enough for huko's source.
 *
 * Returns a copy of `src` with comments replaced by spaces (so line
 * numbers are preserved if anyone ever wants them).
 */
function stripCommentsRobust(src: string): string {
  let out = "";
  let inBlock = false;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = i + 1 < src.length ? src[i + 1] : "";
    if (inBlock) {
      if (ch === "*" && next === "/") { inBlock = false; out += "  "; i += 2; continue; }
      out += ch === "\n" ? "\n" : " "; i++; continue;
    }
    if (inSingle) {
      if (ch === "\\") { out += ch + (next ?? ""); i += 2; continue; }
      if (ch === "'") inSingle = false;
      out += ch ?? ""; i++; continue;
    }
    if (inDouble) {
      if (ch === "\\") { out += ch + (next ?? ""); i += 2; continue; }
      if (ch === '"') inDouble = false;
      out += ch ?? ""; i++; continue;
    }
    if (inBacktick) {
      if (ch === "\\") { out += ch + (next ?? ""); i += 2; continue; }
      if (ch === "`") inBacktick = false;
      out += ch ?? ""; i++; continue;
    }
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true; i += 2; continue;
    }
    if (ch === "'") { inSingle = true; out += ch; i++; continue; }
    if (ch === '"') { inDouble = true; out += ch; i++; continue; }
    if (ch === "`") { inBacktick = true; out += ch; i++; continue; }
    out += ch ?? ""; i++;
  }
  return out;
}

/**
 * Pull every module specifier out of `import`, `export ... from`, and
 * dynamic `import(...)` expressions. Doesn't try to be a real parser;
 * the regex is intentionally simple and covers the patterns huko
 * actually uses.
 */
function extractImportSpecifiers(src: string): string[] {
  const stripped = stripCommentsRobust(src);
  const out: string[] = [];
  // Matches: `from "..."`, `import "..."`, `import("...")`. The `\bfrom`
  // anchor still matches inside string literals like `["from", "to"]`,
  // so we filter captures to module-specifier shape (no whitespace, no
  // commas — real paths never have those).
  const re = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const spec = m[1];
    if (spec === undefined) continue;
    if (/[\s,]/.test(spec)) continue; // not a module path
    out.push(spec);
  }
  return out;
}

function topLevelPackageName(spec: string): string {
  // Scoped: @scope/name or @scope/name/sub → @scope/name
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash === -1) return spec;
    const second = spec.indexOf("/", slash + 1);
    return second === -1 ? spec : spec.slice(0, second);
  }
  // Unscoped: name or name/sub → name
  const slash = spec.indexOf("/");
  return slash === -1 ? spec : spec.slice(0, slash);
}

function isInsideEngine(absPath: string): boolean {
  return (
    absPath === ENGINE_ROOT || absPath.startsWith(ENGINE_ROOT + path.sep)
  );
}

function isInsideShared(absPath: string): boolean {
  return (
    absPath === SHARED_ROOT || absPath.startsWith(SHARED_ROOT + path.sep)
  );
}

type ImportCheck = { ok: true } | { ok: false; reason: string };

function checkImport(importerAbs: string, spec: string): ImportCheck {
  if (spec.startsWith("node:")) return { ok: true };

  // Bare specifier — must be a declared dependency.
  if (!spec.startsWith(".") && !spec.startsWith("/")) {
    const top = topLevelPackageName(spec);
    if (allowedDeps.has(top)) return { ok: true };
    return {
      ok: false,
      reason: `bare import "${spec}" — package "${top}" not in package.json`,
    };
  }

  // Relative — must resolve inside the engine package. `isInsideShared`
  // is technically redundant after the move (shared lives under
  // ENGINE_ROOT/shared/), but keeping it explicit makes the intent
  // obvious to a reader of the diagnostic message.
  const resolved = path.resolve(path.dirname(importerAbs), spec);
  if (isInsideEngine(resolved) || isInsideShared(resolved)) return { ok: true };
  return {
    ok: false,
    reason: `relative import "${spec}" resolves outside the engine package (→ ${path.relative(ENGINE_PKG_ROOT, resolved)})`,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("engine boundary", () => {
  it("src/ exists", () => {
    assert.ok(
      existsSync(ENGINE_ROOT),
      `expected ${path.relative(ENGINE_PKG_ROOT, ENGINE_ROOT)} to exist`,
    );
  });

  it("every TS file under src/ only imports node:*, engine-declared deps, or other engine files", () => {
    if (!existsSync(ENGINE_ROOT)) return;
    const files = walkTs(ENGINE_ROOT);
    const violations: string[] = [];
    const usedLegacy = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const specs = extractImportSpecifiers(src);
      const importerKey = path.relative(ENGINE_PKG_ROOT, file);
      for (const spec of specs) {
        const result = checkImport(file, spec);
        if (result.ok) continue;
        const legacyKey = `${importerKey}::${spec}`;
        if (ALLOWED_LEGACY.has(legacyKey)) {
          usedLegacy.add(legacyKey);
          continue;
        }
        violations.push(`  ${importerKey}: ${result.reason}`);
      }
    }
    if (violations.length > 0) {
      assert.fail(
        "Engine boundary violations. Engine files may only import from\n" +
        "node:*, deps declared in package.json, or\n" +
        "other files inside the engine package. See docs/ (legacy split history)\n" +
        "and the original monorepo extraction plan.\n" +
        violations.join("\n"),
      );
    }
    // Prevent orphan drift: every entry in the allowlist must still
    // apply to a real violation in the tree. If a later PR cleaned up
    // an import without removing its legacy entry, fail loud.
    const orphans = [...ALLOWED_LEGACY].filter((k) => !usedLegacy.has(k));
    if (orphans.length > 0) {
      assert.fail(
        "Orphan entries in ALLOWED_LEGACY (these imports no longer\n" +
        "exist — delete them from the allowlist):\n" +
        orphans.map((k) => `  ${k}`).join("\n"),
      );
    }
  });

  it("no TS file under src/ calls process.cwd() (except allowlisted)", () => {
    if (!existsSync(ENGINE_ROOT)) return;
    const files = walkTs(ENGINE_ROOT);
    const violations: string[] = [];
    const usedAllowlist = new Set<string>();
    for (const file of files) {
      const src = stripCommentsRobust(readFileSync(file, "utf8"));
      if (!/\bprocess\s*\.\s*cwd\s*\(\s*\)/.test(src)) continue;
      const key = path.relative(ENGINE_PKG_ROOT, file);
      if (ALLOWED_LEGACY_CWD_READERS.has(key)) {
        usedAllowlist.add(key);
        continue;
      }
      violations.push(`  ${key}`);
    }
    if (violations.length > 0) {
      assert.fail(
        "Engine code reads process.cwd(). Engine should accept a\n" +
        "`workingDirectory` parameter from the host instead.\n" +
        violations.join("\n"),
      );
    }
    const orphans = [...ALLOWED_LEGACY_CWD_READERS].filter(
      (k) => !usedAllowlist.has(k),
    );
    if (orphans.length > 0) {
      assert.fail(
        "Orphan entries in ALLOWED_LEGACY_CWD_READERS (these files no\n" +
        "longer call process.cwd() — delete them from the allowlist):\n" +
        orphans.map((k) => `  ${k}`).join("\n"),
      );
    }
  });
});

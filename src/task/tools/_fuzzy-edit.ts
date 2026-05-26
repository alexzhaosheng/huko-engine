/**
 * server/task/tools/server/_fuzzy-edit.ts
 *
 * Whitespace-tolerant find-and-replace fallback for the `edit_file`
 * tool. Ported verbatim from WeavesAI's `server/tools/fuzzy-edit.ts`
 * (the user's own open-source project) — its design and edge cases
 * have been validated against many real edit failures.
 *
 * Design principles (unchanged from WeavesAI):
 *   - Exact match is always tried first (zero overhead for the happy path).
 *   - Fuzzy match only activates on exact-match failure (fallback, not default).
 *   - Fuzzy match normalises whitespace (leading indent, trailing spaces,
 *     blank-line differences) but NEVER changes non-whitespace characters.
 *   - When fuzzy match succeeds, the replacement text's indentation is
 *     auto-aligned to the matched block's actual indentation.
 *   - Pure utility module — no I/O, no state, no platform branches.
 */

// ─── Types ───

export type FuzzyMatchResult = {
  found: boolean;
  startIndex: number;
  endIndex: number;
  matchType: "exact" | "fuzzy" | "none";
  matchedText: string;
  /**
   * Tab width (in spaces) that successfully bridged tabs ↔ spaces
   * during a fuzzy match. Undefined for exact / not-found results.
   * Propagated to `alignIndentation` so the replacement re-indent
   * uses the SAME assumption that won the match — otherwise we could
   * pick a delta that's correct for tab=4 but wrong for tab=2.
   */
  tabWidth?: number;
};

export type FuzzyEditResult = {
  content: string;
  matchType: "exact" | "fuzzy";
};

/**
 * Tab widths attempted during fuzzy match, in priority order. 4 wins
 * for most LLM-emitted TS/Go/Python (4-space indent ⇆ tab); 2 covers
 * older codebases; 8 covers Makefiles and historical Unix style.
 * Trying tab=1 is intentionally omitted — at width 1 every tab matches
 * a single space, which produces false positives in dense code.
 *
 * Cost: at most 3 normalisation passes per fuzzy attempt, each O(n).
 * The exact-match fast path (always tried first) means the happy path
 * pays nothing for this.
 */
const TAB_WIDTHS_TO_TRY: readonly number[] = [4, 2, 8] as const;

// ─── Core: Fuzzy Find ───

export function fuzzyFind(haystack: string, needle: string): FuzzyMatchResult {
  // 1. Exact match — always preferred.
  const exactIdx = haystack.indexOf(needle);
  if (exactIdx !== -1) {
    return {
      found: true,
      startIndex: exactIdx,
      endIndex: exactIdx + needle.length,
      matchType: "exact",
      matchedText: needle,
    };
  }

  // 2. Fuzzy match — try common tab widths in priority order. First
  //    width that finds a match wins; the result carries the width so
  //    alignIndentation can re-use it.
  for (const tabWidth of TAB_WIDTHS_TO_TRY) {
    const result = fuzzyFindAtTabWidth(haystack, needle, tabWidth);
    if (result.found) return result;
  }
  return { found: false, startIndex: -1, endIndex: -1, matchType: "none", matchedText: "" };
}

function fuzzyFindAtTabWidth(
  haystack: string,
  needle: string,
  tabWidth: number,
): FuzzyMatchResult {
  const needleLines = needle.split("\n");
  const haystackLines = haystack.split("\n");

  const normaliseLine = (line: string): string =>
    line.trimEnd().replace(/^[ \t]+/, (ws) => {
      const expanded = ws.replace(/\t/g, " ".repeat(tabWidth));
      return " ".repeat(expanded.length);
    });

  const normalisedNeedle = needleLines.map(normaliseLine);

  // Trim leading/trailing blank lines from the needle so they don't
  // skew the search; we'll re-attach them at the matched site.
  let needleStart = 0;
  let needleEnd = normalisedNeedle.length;
  while (needleStart < needleEnd && normalisedNeedle[needleStart]!.trim() === "") needleStart++;
  while (needleEnd > needleStart && normalisedNeedle[needleEnd - 1]!.trim() === "") needleEnd--;

  const trimmedNeedle = normalisedNeedle.slice(needleStart, needleEnd);
  if (trimmedNeedle.length === 0) {
    return { found: false, startIndex: -1, endIndex: -1, matchType: "none", matchedText: "" };
  }

  const normalisedHaystack = haystackLines.map(normaliseLine);

  for (let i = 0; i <= normalisedHaystack.length - trimmedNeedle.length; i++) {
    let matched = true;
    for (let j = 0; j < trimmedNeedle.length; j++) {
      if (normalisedHaystack[i + j] !== trimmedNeedle[j]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    let matchStartLine = i;
    let matchEndLine = i + trimmedNeedle.length;

    // Re-extend over the leading/trailing blank lines we trimmed off
    // the needle, but only as far as the haystack has matching blanks.
    let leadingBlanks = needleStart;
    while (leadingBlanks > 0 && matchStartLine > 0 && haystackLines[matchStartLine - 1]!.trim() === "") {
      matchStartLine--;
      leadingBlanks--;
    }

    let trailingBlanks = normalisedNeedle.length - needleEnd;
    while (trailingBlanks > 0 && matchEndLine < haystackLines.length && haystackLines[matchEndLine]!.trim() === "") {
      matchEndLine++;
      trailingBlanks--;
    }

    // Convert line indices back to character indices.
    let startCharIdx = 0;
    for (let k = 0; k < matchStartLine; k++) {
      startCharIdx += haystackLines[k]!.length + 1;
    }
    let endCharIdx = startCharIdx;
    for (let k = matchStartLine; k < matchEndLine; k++) {
      endCharIdx += haystackLines[k]!.length + 1;
    }
    if (endCharIdx > haystack.length) endCharIdx = haystack.length;
    if (endCharIdx > 0 && haystack[endCharIdx - 1] === "\n" && !needle.endsWith("\n")) {
      endCharIdx--;
    }

    return {
      found: true,
      startIndex: startCharIdx,
      endIndex: endCharIdx,
      matchType: "fuzzy",
      matchedText: haystack.slice(startCharIdx, endCharIdx),
      tabWidth,
    };
  }

  return { found: false, startIndex: -1, endIndex: -1, matchType: "none", matchedText: "" };
}

// ─── Core: Fuzzy Edit ───

export function fuzzyEdit(
  content: string,
  find: string,
  replace: string,
): FuzzyEditResult | null {
  const match = fuzzyFind(content, find);
  if (!match.found) return null;

  let finalReplace = replace;
  if (match.matchType === "fuzzy") {
    // Use the tab width that won the match (fuzzyFind populates it on
    // any fuzzy hit). The fallback to 4 only kicks in if a future code
    // path produces a fuzzy result without setting tabWidth — keeps
    // the contract loose for callers, default matches modern style.
    const tabWidth = match.tabWidth ?? 4;
    finalReplace = alignIndentation(find, match.matchedText, replace, tabWidth);
  }

  const newContent =
    content.slice(0, match.startIndex) +
    finalReplace +
    content.slice(match.endIndex);

  return {
    content: newContent,
    matchType: match.matchType as FuzzyEditResult["matchType"],
  };
}

// ─── Indentation Alignment ───

function alignIndentation(
  find: string,
  matched: string,
  replace: string,
  tabWidth: number,
): string {
  const findLines = find.split("\n");
  const matchedLines = matched.split("\n");

  const findIndent = getFirstNonEmptyIndent(findLines, tabWidth);
  const matchedIndent = getFirstNonEmptyIndent(matchedLines, tabWidth);
  if (findIndent === null || matchedIndent === null) return replace;

  const delta = matchedIndent - findIndent;
  // Detect the file's indent character so we can re-emit the
  // replacement in the same style. Otherwise a tabs-file would end up
  // with the replaced block using spaces (visually broken even though
  // the edit "succeeded").
  const useTabs = matchedUsesTabs(matchedLines);

  return replace
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      const currentIndent = line.match(/^[ \t]*/)?.[0] ?? "";
      const currentSpaces = currentIndent.replace(/\t/g, " ".repeat(tabWidth)).length;
      const newSpaces = Math.max(0, currentSpaces + delta);
      const body = line.trimStart();
      return renderIndent(newSpaces, useTabs, tabWidth) + body;
    })
    .join("\n");
}

/**
 * Render N "indent units" using either tabs or spaces, matching the
 * file's style. `tabWidth > 0` is guaranteed by the caller (the
 * fuzzy-match path that gets here always picked a positive width).
 */
function renderIndent(spaces: number, useTabs: boolean, tabWidth: number): string {
  if (!useTabs) return " ".repeat(spaces);
  const tabs = Math.floor(spaces / tabWidth);
  const remainder = spaces % tabWidth;
  return "\t".repeat(tabs) + " ".repeat(remainder);
}

function matchedUsesTabs(lines: string[]): boolean {
  for (const line of lines) {
    const m = line.match(/^[ \t]+/);
    if (m && m[0].includes("\t")) return true;
  }
  return false;
}

function getFirstNonEmptyIndent(lines: string[], tabWidth: number): number | null {
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = line.match(/^[ \t]*/)?.[0] ?? "";
    return indent.replace(/\t/g, " ".repeat(tabWidth)).length;
  }
  return null;
}

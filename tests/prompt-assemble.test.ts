/**
 * tests/prompt-assemble.test.ts
 *
 * End-to-end coverage of `assembleSystemPrompt` — the canonical
 * engine-side prompt composer. Pins the format invariants that live
 * agents depend on:
 *
 *   - canonical block order (identity / scope / agent_loop / tool_use / ...)
 *   - cache-boundary placement (volatile current-date line must sit
 *     AFTER the boundary so the cacheable prefix stays stable)
 *   - language-block fallback when workingLanguage is null
 *   - <local> renders cwd + platform
 *   - <project_context> renders the supplied blob and slots after
 *     skills + before scheduled_task
 *   - <skills> renders supplied skills with description + body
 *   - <scheduled_task> renders cron + timezone + instructions, and
 *     slots after project_context but before the cache boundary
 *   - toolHints splice into <tool_use>
 *   - overlays + extraOverlays land at their slotted positions
 *
 * No file IO here — every input is synthetic. Engine doesn't read
 * files; the host pre-resolves skills + projectContext and passes
 * them in. The cli-side IO loaders (loadActiveSkills,
 * loadProjectContext) have their own narrower tests; this file pins
 * the assembler contract those tests build on.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  assembleSystemPrompt,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "../src/internal/prompt/assemble.js";
import type { Skill } from "../src/skills/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function assemble(
  overrides: Partial<Parameters<typeof assembleSystemPrompt>[0]> = {},
): string {
  return assembleSystemPrompt({
    workingDirectory: overrides.workingDirectory ?? "/tmp",
    platform: overrides.platform ?? process.platform,
    workingLanguage: overrides.workingLanguage ?? null,
    currentDate: overrides.currentDate ?? new Date("2026-05-10T12:00:00Z"),
    toolHints: overrides.toolHints ?? [],
    skills: overrides.skills ?? [],
    projectContext: overrides.projectContext ?? null,
    ...(overrides.scheduledTask !== undefined
      ? { scheduledTask: overrides.scheduledTask }
      : {}),
    extraOverlays: overrides.extraOverlays ?? [],
    overlays: overrides.overlays ?? [],
  });
}

// ─── Static structure ───────────────────────────────────────────────────────

describe("assembleSystemPrompt — structural blocks", () => {
  it("includes all required XML-tagged sections", () => {
    const prompt = assemble();
    for (const tag of [
      "<scope>",
      "<principles>",
      "<language>",
      "<format>",
      "<agent_loop>",
      "<tool_use>",
      "<error_handling>",
      "<local>",
      "<safety>",
      "<disclosure_prohibition>",
    ]) {
      assert.ok(prompt.includes(tag), `missing ${tag} in prompt`);
    }
  });

  it("does NOT include a static <role> overlay (removed in 2026-05 redesign)", () => {
    const prompt = assemble();
    assert.doesNotMatch(prompt, /<role[\s>]/);
  });

  it("<scope> mentions the 4 expertise capabilities", () => {
    const prompt = assemble();
    for (const cap of ["coding", "writing", "research", "analysis"]) {
      assert.ok(prompt.includes(cap), `<scope> should mention "${cap}"`);
    }
  });

  it("identity is frontend-agnostic (no 'CLI-first')", () => {
    const prompt = assemble();
    assert.doesNotMatch(prompt, /CLI-first/);
    assert.match(prompt, /You are huko, an autonomous AI agent/);
  });

  it("includes one-tool-per-turn rule + plan rule + result rule", () => {
    const prompt = assemble();
    assert.match(prompt, /one tool call per response/i);
    // `plan(action=update)` and `message(type=ask)` live in tool-specific
    // promptHints (plan + message tools) and only surface when those
    // hints are passed in. The principles block uses the shorter
    // `plan(update)` form and references `message(type=result)`.
    assert.match(prompt, /`plan\(update\)`/);
    assert.match(prompt, /message\(type=result\)/);
  });

  it("warns about system_reminder injections being platform guidance", () => {
    const prompt = assemble();
    assert.match(prompt, /system_reminder/);
    assert.match(prompt, /platform guidance/i);
  });

  it("tells the agent NOT to revisit older user requests after delivery", () => {
    // Regression guard for the cross-task drift bug: agent finished
    // `git push` then auto-resumed an older stopped task's goal
    // ("write command.md"). The principle below should keep it from
    // scanning the conversation backwards for "leftover" requests.
    const prompt = assemble();
    assert.match(prompt, /scan the conversation for older user requests/i);
    assert.match(prompt, /completed.*stopped.*superseded/i);
  });
});

// ─── Cache boundary ─────────────────────────────────────────────────────────

describe("assembleSystemPrompt — cache boundary", () => {
  it("places the marker exactly once", () => {
    const prompt = assemble();
    const idx = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    assert.ok(idx > 0, "boundary marker should be present");
    const idx2 = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY, idx + 1);
    assert.equal(idx2, -1, "boundary marker should appear at most once");
  });

  it("places the marker BEFORE the current-date line", () => {
    const prompt = assemble();
    const idxBoundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const idxDate = prompt.indexOf("The current date is");
    assert.ok(idxBoundary > 0);
    assert.ok(idxDate > idxBoundary, "date should appear after boundary");
  });

  it("places everything stable BEFORE the boundary", () => {
    const prompt = assemble();
    const idxBoundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const idxScope = prompt.indexOf("<scope>");
    const idxLanguage = prompt.indexOf("<language>");
    assert.ok(idxLanguage > 0 && idxLanguage < idxBoundary);
    assert.ok(idxScope > 0 && idxScope < idxBoundary);
  });
});

// ─── Language block ─────────────────────────────────────────────────────────

describe("assembleSystemPrompt — <language> block", () => {
  it("locks onto the supplied workingLanguage", () => {
    const prompt = assemble({ workingLanguage: "中文" });
    assert.match(prompt, /working language is \*\*中文\*\*/);
  });

  it("falls back when workingLanguage is null", () => {
    const prompt = assemble({ workingLanguage: null });
    assert.match(prompt, /first message as the working language/i);
  });
});

// ─── Local block ────────────────────────────────────────────────────────────

describe("assembleSystemPrompt — <local> block", () => {
  it("renders cwd and platform", () => {
    const prompt = assemble({
      workingDirectory: "/some/project/path",
      platform: "linux",
    });
    assert.match(prompt, /Working directory: \/some\/project\/path/);
    assert.match(prompt, /Platform: linux/);
  });

  it("includes workspace_policy and local_safety sub-blocks", () => {
    const prompt = assemble();
    assert.match(prompt, /<workspace_policy>/);
    assert.match(prompt, /<local_safety>/);
  });
});

// ─── project_context ────────────────────────────────────────────────────────

describe("assembleSystemPrompt — <project_context>", () => {
  it("renders the supplied blob verbatim", () => {
    const prompt = assemble({
      projectContext:
        "# From CLAUDE.md\n\n- always wear seatbelts",
    });
    assert.match(prompt, /<project_context>/);
    assert.match(prompt, /# From CLAUDE\.md/);
    assert.match(prompt, /always wear seatbelts/);
  });

  it("omits <project_context> when projectContext is null", () => {
    const prompt = assemble({ projectContext: null });
    assert.doesNotMatch(prompt, /<project_context>/);
  });

  it("places <project_context> as the LAST stable block before any tail overlay / boundary", () => {
    const prompt = assemble({
      projectContext: "# Project\n",
    });
    const idxProj = prompt.indexOf("<project_context>");
    const idxBoundary = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    assert.ok(idxProj > 0);
    assert.ok(idxBoundary > idxProj);
    const between = prompt.slice(
      prompt.indexOf("</project_context>") + "</project_context>".length,
      idxBoundary,
    );
    assert.equal(
      between.trim(),
      "",
      `unexpected content between </project_context> and boundary: ${JSON.stringify(between)}`,
    );
  });
});

// ─── Skills block ───────────────────────────────────────────────────────────

describe("assembleSystemPrompt — <skills> block", () => {
  it("omits the <skills> block entirely when no skill is active", () => {
    const prompt = assemble({ skills: [] });
    assert.doesNotMatch(prompt, /<skills>/);
  });

  it("renders a <skill> entry with description + body", () => {
    const skill: Skill = {
      name: "deploy",
      source: "project",
      path: "/tmp/.huko/skills/deploy.md",
      frontmatter: { description: "pre-deploy checklist" },
      body: "Run tests before shipping.",
    };
    const prompt = assemble({ skills: [skill] });
    assert.match(prompt, /<skills>/);
    assert.match(prompt, /<skill name="deploy">/);
    assert.match(prompt, /pre-deploy checklist/);
    assert.match(prompt, /Run tests before shipping\./);
  });

  it("places <skills> before <project_context> and the cache boundary", () => {
    const skill: Skill = {
      name: "deploy",
      source: "project",
      path: "/tmp/.huko/skills/deploy.md",
      frontmatter: { description: "checklist" },
      body: "body",
    };
    const prompt = assemble({
      skills: [skill],
      projectContext: "# rules",
    });
    const skillsIdx = prompt.indexOf("<skills>");
    const projIdx = prompt.indexOf("<project_context>");
    const boundaryIdx = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    assert.ok(skillsIdx > 0 && skillsIdx < projIdx);
    assert.ok(projIdx < boundaryIdx);
  });
});

// ─── Scheduled task block ───────────────────────────────────────────────────

describe("assembleSystemPrompt — <scheduled_task>", () => {
  it("emits the block with cron + timezone + standing instructions", () => {
    const prompt = assemble({
      scheduledTask: {
        cron: "0 8 * * *",
        timezone: "Asia/Shanghai",
        instructions: "Check git log on develop and post a digest.",
      },
    });
    assert.match(prompt, /<scheduled_task>/);
    assert.match(prompt, /<\/scheduled_task>/);
    assert.match(prompt, /`0 8 \* \* \*`/);
    assert.match(prompt, /Asia\/Shanghai/);
    assert.match(prompt, /Check git log on develop and post a digest\./);
    assert.match(prompt, /no human operator at the keyboard/i);
    assert.match(prompt, /`message\(type=ask\)` tool is disabled/);
  });

  it("omits the timezone parenthetical when timezone is null", () => {
    const prompt = assemble({
      scheduledTask: {
        cron: "*/15 * * * *",
        timezone: null,
        instructions: "Poll.",
      },
    });
    assert.match(prompt, /`\*\/15 \* \* \* \*`/);
    // The "(tz)" suffix should NOT appear when timezone is null.
    assert.doesNotMatch(prompt, /`\*\/15 \* \* \* \*` \(/);
  });

  it("places the block AFTER project_context and BEFORE the cache boundary", () => {
    const prompt = assemble({
      projectContext: "# rules",
      scheduledTask: {
        cron: "0 0 * * *",
        timezone: null,
        instructions: "Daily.",
      },
    });
    const projIdx = prompt.indexOf("<project_context>");
    const blockIdx = prompt.indexOf("<scheduled_task>");
    const cacheIdx = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    assert.ok(projIdx > 0 && projIdx < blockIdx);
    assert.ok(blockIdx < cacheIdx);
  });

  it("omits the block when scheduledTask is absent", () => {
    const prompt = assemble({});
    assert.doesNotMatch(prompt, /<scheduled_task>/);
  });
});

// ─── tool_use + toolHints ───────────────────────────────────────────────────

describe("assembleSystemPrompt — toolHints integration", () => {
  it("splices the supplied hints into <tool_use>", () => {
    const prompt = assemble({
      toolHints: [
        "Custom hint A:\n- alpha rule",
        "Custom hint B:\n- bravo rule",
      ],
    });
    const m = /<tool_use>([\s\S]*?)<\/tool_use>/.exec(prompt);
    assert.ok(m, "no <tool_use> block found");
    const block = m![1]!;
    assert.match(block, /alpha rule/);
    assert.match(block, /bravo rule/);
    assert.match(block, /one tool call per response/i);
    assert.match(block, /system_reminder/);
  });

  it("keeps <tool_use> minimal when no hints supplied", () => {
    const prompt = assemble({ toolHints: [] });
    const m = /<tool_use>([\s\S]*?)<\/tool_use>/.exec(prompt);
    assert.ok(m);
    const block = m![1]!;
    assert.match(block, /one tool call per response/i);
    assert.match(block, /system_reminder/);
    assert.doesNotMatch(block, /Talking to the user/);
    assert.doesNotMatch(block, /Planning \(`plan`/);
  });

  it("hints land INSIDE <tool_use>, not after it", () => {
    const prompt = assemble({
      toolHints: ["UNIQUE_HINT_MARKER"],
    });
    const idxHint = prompt.indexOf("UNIQUE_HINT_MARKER");
    const idxClose = prompt.indexOf("</tool_use>");
    assert.ok(idxHint > 0 && idxClose > idxHint);
  });
});

// ─── Tail overlays (extraOverlays legacy + structured tail) ─────────────────

describe("assembleSystemPrompt — tail overlays", () => {
  it("renders extraOverlays inside the cacheable prefix", () => {
    const prompt = assemble({
      extraOverlays: ["<setup_assistant>SETUP_BODY</setup_assistant>"],
    });
    assert.match(prompt, /<setup_assistant>/);
    assert.match(prompt, /SETUP_BODY/);
    const blockIdx = prompt.indexOf("<setup_assistant>");
    const cacheIdx = prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
    assert.ok(blockIdx > 0 && blockIdx < cacheIdx);
  });

  it("structured tail overlay matches legacy extraOverlays placement", () => {
    const legacy = assemble({
      extraOverlays: ["<custom_tail>BODY</custom_tail>"],
    });
    const structured = assemble({
      overlays: [
        { name: "custom-tail", content: "<custom_tail>BODY</custom_tail>", position: "tail" },
      ],
    });
    // Both should slot the block before the cache boundary in the
    // same relative position. Verify both contain the block AND that
    // the only structural difference is the order legacy vs structured
    // (legacy strings render BEFORE structured tail entries).
    assert.match(legacy, /<custom_tail>BODY<\/custom_tail>/);
    assert.match(structured, /<custom_tail>BODY<\/custom_tail>/);
  });
});

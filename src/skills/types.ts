/**
 * server/engine/skills/types.ts
 *
 * Type primitives for the skill loader. The wire shape both engine
 * (parse / active-set computation) and host (file discovery + read)
 * agree on.
 *
 * A skill is a user-authored markdown file with optional YAML
 * frontmatter. Once loaded, every implementation hands the agent loop
 * a `Skill` of this shape — the rest of the system doesn't care
 * whether it came from `~/.huko/skills/foo.md` or some future
 * non-filesystem source.
 */

/** Parsed frontmatter for a skill. Unrecognised keys are dropped on load. */
export type SkillFrontmatter = {
  /** One-line description shown in the system prompt index + `skills list`. */
  description?: string;
};

/** Which layer the skill was discovered in. */
export type SkillSource = "project" | "user";

export type Skill = {
  /** Stable identifier; matches the file stem or the containing folder name. */
  name: string;
  /** Which layer the skill was loaded from. */
  source: SkillSource;
  /** Absolute path to the markdown file the body came from. */
  path: string;
  /** Parsed frontmatter (`{}` when the file has no fence). */
  frontmatter: SkillFrontmatter;
  /** Markdown body (frontmatter stripped, trimmed). */
  body: string;
};

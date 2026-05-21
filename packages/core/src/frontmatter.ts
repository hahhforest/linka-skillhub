import YAML from "yaml";
import type { ParseIssue, SkillFrontmatter } from "./types.js";

export interface ParsedSkillMarkdown {
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
  readonly issues: readonly ParseIssue[];
}

export const parseSkillMarkdown = (content: string): ParsedSkillMarkdown => {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return {
      frontmatter: {},
      body: content,
      issues: [{ code: "missing_frontmatter", message: "SKILL.md must start with YAML frontmatter." }]
    };
  }

  const normalized = content.replaceAll("\r\n", "\n");
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) {
    return {
      frontmatter: {},
      body: normalized,
      issues: [{ code: "unterminated_frontmatter", message: "YAML frontmatter is not closed by a second --- marker." }]
    };
  }

  const yamlText = normalized.slice(4, end);
  const body = normalized.slice(end + "\n---\n".length);
  try {
    const parsed = YAML.parse(yamlText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        frontmatter: {},
        body,
        issues: [{ code: "frontmatter_not_object", message: "YAML frontmatter must parse to an object." }]
      };
    }
    return { frontmatter: parsed as SkillFrontmatter, body, issues: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      frontmatter: {},
      body,
      issues: [{ code: "invalid_yaml", message }]
    };
  }
};

export const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

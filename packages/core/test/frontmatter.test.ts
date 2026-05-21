import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../src/frontmatter.js";
import { findSafetyIssues, isKebabName } from "../src/safety.js";

describe("frontmatter parser", () => {
  it("parses a valid SKILL.md header", () => {
    const parsed = parseSkillMarkdown("---\nname: sample-skill\ndescription: Useful skill\n---\n# Body\n");
    expect(parsed.issues).toEqual([]);
    expect(parsed.frontmatter.name).toBe("sample-skill");
    expect(parsed.frontmatter.description).toBe("Useful skill");
  });

  it("surfaces invalid YAML shape such as sequence description", () => {
    const parsed = parseSkillMarkdown("---\nname: broken\ndescription:\n  - invalid\n---\n# Body\n");
    expect(parsed.issues).toEqual([]);
    expect(Array.isArray(parsed.frontmatter.description)).toBe(true);
  });
});

describe("safety rules", () => {
  it("detects credential-looking literals", () => {
    const findings = findSafetyIssues("apiKey = 'abcdefghijklmnopqrstuvwxyz123456'");
    expect(findings.map((finding) => finding.code)).toContain("credential_literal");
  });

  it("accepts lowercase kebab-case names", () => {
    expect(isKebabName("skill-hub")).toBe(true);
    expect(isKebabName("SkillHub")).toBe(false);
  });
});

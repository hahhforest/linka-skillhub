import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { asNonEmptyString, parseSkillMarkdown } from "./frontmatter.js";
import { hashDirectory } from "./hash.js";
import { assertPathInside } from "./path-safety.js";
import { classifySkill } from "./scanner.js";
import type { ParseIssue, RegistryManifest, SkillFrontmatter, SkillPackage } from "./types.js";

export class UnsafeSourceError extends Error {
  readonly code = "ERR_UNSAFE_SOURCE";
  constructor(message: string) {
    super(message);
  }
}

export interface FrontmatterFixOptions {
  readonly cwd?: string;
  readonly profileRoot?: string;
  readonly allowUnsafeSource?: boolean;
  readonly dryRun?: boolean;
  readonly descriptionMaxLength?: number;
  readonly now?: Date;
}

export interface FrontmatterFixResult {
  readonly skillId: string;
  readonly skillDir: string;
  readonly applied: boolean;
  readonly reason?: "frontmatter_already_present" | "unsafe_source_blocked" | "dry_run" | "skill_not_found";
  readonly previousIssues: readonly ParseIssue[];
  readonly newFrontmatter?: SkillFrontmatter;
  readonly writtenPath?: string;
  readonly auto_fixed: true;
}

export const inferNameFromDirectory = (skillDir: string): string => {
  const base = path.basename(skillDir);
  const slug = base
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unnamed-skill";
};

export const inferDescriptionFromBody = (body: string, maxLength = 200): string => {
  const lines = body.split(/\r?\n/);
  const collected: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (started) collected.push(" ");
      continue;
    }
    if (started && /^#{1,6}\s/.test(trimmed)) break;
    const cleaned = /^#{1,6}\s+/.test(trimmed) ? trimmed.replace(/^#{1,6}\s+/, "") : trimmed;
    collected.push(cleaned);
    started = true;
  }
  const joined = collected.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length <= maxLength) return joined;
  return `${joined.slice(0, maxLength - 1).trimEnd()}…`;
};

export const composeFrontmatter = (name: string, description: string): string => {
  const fm: SkillFrontmatter = { name, description };
  const yaml = YAML.stringify(fm, { lineWidth: 0 }).replace(/\s+$/, "");
  return `---\n${yaml}\n---\n`;
};

const isValidFrontmatter = (fm: SkillFrontmatter): boolean => {
  const name = typeof fm.name === "string" && fm.name.trim().length > 0;
  const description = typeof fm.description === "string" && fm.description.trim().length > 0;
  return name && description;
};

export const applyFrontmatterFix = async (
  skill: SkillPackage,
  options: FrontmatterFixOptions = {}
): Promise<FrontmatterFixResult> => {
  const previousIssues = [...skill.issues];
  const baseResult = {
    skillId: skill.id,
    skillDir: skill.skillDir,
    previousIssues,
    auto_fixed: true as const
  };

  if (skill.status.includes("invalid") === false) {
    return { ...baseResult, applied: false, reason: "frontmatter_already_present" };
  }

  if (options.profileRoot) {
    assertPathInside(options.profileRoot, skill.skillDir, "auto-fix source");
  }
  if (options.allowUnsafeSource !== true && options.profileRoot === undefined) {
    throw new UnsafeSourceError(
      `Refusing to write frontmatter to ${skill.skillDir}: no profileRoot provided and --allow-unsafe-source was not set.`
    );
  }

  const raw = await fs.readFile(skill.skillFile, "utf8");
  const parsed = parseSkillMarkdown(raw);
  if (isValidFrontmatter(parsed.frontmatter)) {
    return { ...baseResult, applied: false, reason: "frontmatter_already_present" };
  }

  const name = inferNameFromDirectory(skill.skillDir);
  const description = inferDescriptionFromBody(parsed.body, options.descriptionMaxLength ?? 200);
  const newFrontmatter: SkillFrontmatter = { name, description };
  const composed = composeFrontmatter(name, description);
  const rewritten = `${composed}${parsed.body.replace(/^\s+/, "")}`;

  if (options.dryRun) {
    return {
      ...baseResult,
      applied: false,
      reason: "dry_run",
      newFrontmatter
    };
  }

  await fs.writeFile(skill.skillFile, rewritten, "utf8");
  return {
    ...baseResult,
    applied: true,
    newFrontmatter,
    writtenPath: skill.skillFile
  };
};

export const refreshSkillManifestEntry = async (
  skill: SkillPackage,
  options: { readonly now?: Date } = {}
): Promise<SkillPackage> => {
  const content = await fs.readFile(skill.skillFile, "utf8");
  const parsed = parseSkillMarkdown(content);
  const directoryName = path.basename(skill.skillDir);
  const name = asNonEmptyString(parsed.frontmatter.name) ?? skill.name;
  const description = asNonEmptyString(parsed.frontmatter.description) ?? "";
  const classification = classifySkill({
    name: asNonEmptyString(parsed.frontmatter.name),
    description: asNonEmptyString(parsed.frontmatter.description),
    directoryName,
    content,
    issues: parsed.issues
  });

  return {
    ...skill,
    name,
    directoryName,
    description,
    hash: await hashDirectory(skill.realPath),
    frontmatter: parsed.frontmatter,
    status: classification.status,
    issues: classification.issues,
    evidence: classification.evidence,
    updatedAt: (options.now ?? new Date()).toISOString()
  };
};

export const findInvalidSkills = (manifest: RegistryManifest): SkillPackage[] =>
  manifest.skills.filter((skill) => skill.status.includes("invalid"));

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyFrontmatterFix,
  composeFrontmatter,
  findInvalidSkills,
  inferDescriptionFromBody,
  inferNameFromDirectory,
  refreshSkillManifestEntry,
  UnsafeSourceError
} from "../src/frontmatter-fix.js";
import { discoverSkillSources, importSkillsToRepository, writeRegistryManifest } from "../src/index.js";
import type { RegistryManifest, SkillPackage } from "../src/types.js";

const writeSkillFile = async (skillDir: string, body: string): Promise<void> => {
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), body, "utf8");
};

const discoverOpenCodeSourceId = async (cwd: string): Promise<string> => {
  const sources = await discoverSkillSources(cwd);
  const target = sources.find((source) => source.rootPath === path.join(cwd, ".opencode", "skills"));
  if (!target) throw new Error(`Test setup failed: opencode source not discovered for cwd=${cwd}`);
  return target.id;
};

const setupInvalidSkill = async (cwd: string, name: string): Promise<SkillPackage> => {
  const skillDir = path.join(cwd, ".opencode", "skills", name);
  await writeSkillFile(skillDir, `# ${name}\n\nThis skill orchestrates the ${name} workflow.\n`);
  const sourceId = await discoverOpenCodeSourceId(cwd);
  const repoPath = path.join(cwd, "registry");
  const result = await importSkillsToRepository({ repoPath, cwd, includeDefaultExcluded: true, selectedSourceIds: [sourceId] });
  const manifestPath = path.join(repoPath, "registry", "skills.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as RegistryManifest;
  const skill = manifest.skills.find((entry) => entry.directoryName === name);
  if (!skill) throw new Error(`Test setup failed: skill ${name} not found in manifest`);
  return skill;
};

const setupValidSkill = async (cwd: string, name: string): Promise<SkillPackage> => {
  const skillDir = path.join(cwd, ".opencode", "skills", name);
  await writeSkillFile(skillDir, `---\nname: ${name}\ndescription: Already valid skill\n---\n# Body\n`);
  const sourceId = await discoverOpenCodeSourceId(cwd);
  const repoPath = path.join(cwd, "registry");
  const result = await importSkillsToRepository({ repoPath, cwd, includeDefaultExcluded: true, selectedSourceIds: [sourceId] });
  const skill = result.manifest.skills.find((entry) => entry.directoryName === name);
  if (!skill) throw new Error(`Test setup failed: valid skill ${name} not found in manifest`);
  return skill;
};

describe("frontmatter-fix helpers", () => {
  it("infers kebab name from directory", () => {
    expect(inferNameFromDirectory("/tmp/Cool_Skill 2")).toBe("cool-skill-2");
    expect(inferNameFromDirectory("/tmp/!!!")).toBe("unnamed-skill");
  });

  it("infers description from first heading paragraph", () => {
    const desc = inferDescriptionFromBody("# Hello World\n\nThis is the body.\n\nMore lines.", 80);
    expect(desc.startsWith("Hello World")).toBe(true);
    expect(desc).toContain("This is the body");
  });

  it("truncates description with ellipsis when over maxLength", () => {
    const long = "a".repeat(500);
    const out = inferDescriptionFromBody(long, 50);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it("composes YAML frontmatter that re-parses correctly", () => {
    const composed = composeFrontmatter("alpha", "first");
    expect(composed.startsWith("---\n")).toBe(true);
    expect(composed.endsWith("---\n")).toBe(true);
    expect(composed).toContain("name: alpha");
    expect(composed).toContain("description: first");
  });
});

describe("applyFrontmatterFix", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lsh-fm-"));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("skips when frontmatter already valid", async () => {
    const skill = await setupValidSkill(cwd, "valid-skill");
    const fix = await applyFrontmatterFix(skill, { profileRoot: cwd, allowUnsafeSource: true });
    expect(fix.applied).toBe(false);
    expect(fix.reason).toBe("frontmatter_already_present");
  });

  it("rewrites a SKILL.md without frontmatter and reports auto_fixed=true", async () => {
    const skill = await setupInvalidSkill(cwd, "collab-canvas");
    const fix = await applyFrontmatterFix(skill, { profileRoot: cwd, allowUnsafeSource: true });
    expect(fix.applied).toBe(true);
    expect(fix.newFrontmatter?.name).toBe("collab-canvas");
    expect(fix.auto_fixed).toBe(true);
    expect(fix.writtenPath).toBe(skill.skillFile);
    const rewritten = await fs.readFile(skill.skillFile, "utf8");
    expect(rewritten.startsWith("---\n")).toBe(true);
    expect(rewritten).toContain("name: collab-canvas");
  });

  it("allows fixing canonical skills inside a registry repo root", async () => {
    const skill = await setupInvalidSkill(cwd, "registry-skill");
    const repoRoot = path.join(cwd, "registry");
    const fix = await applyFrontmatterFix(skill, { profileRoot: repoRoot });

    expect(fix.applied).toBe(true);
    expect(fix.writtenPath).toBe(skill.skillFile);
    const rewritten = await fs.readFile(skill.skillFile, "utf8");
    expect(rewritten.startsWith("---\n")).toBe(true);
    expect(rewritten).toContain("name: registry-skill");
  });

  it("dryRun returns a new frontmatter without writing", async () => {
    const skill = await setupInvalidSkill(cwd, "dry-skill");
    const before = await fs.readFile(skill.skillFile, "utf8");
    const fix = await applyFrontmatterFix(skill, { profileRoot: cwd, allowUnsafeSource: true, dryRun: true });
    expect(fix.applied).toBe(false);
    expect(fix.reason).toBe("dry_run");
    expect(fix.newFrontmatter?.name).toBe("dry-skill");
    const after = await fs.readFile(skill.skillFile, "utf8");
    expect(after).toBe(before);
  });

  it("refreshes a stale invalid manifest entry from valid SKILL.md frontmatter", async () => {
    const skill = await setupInvalidSkill(cwd, "stale-skill");
    await fs.writeFile(
      skill.skillFile,
      "---\nname: stale-skill\ndescription: Refreshed from disk\n---\n# Body\n",
      "utf8"
    );

    const refreshed = await refreshSkillManifestEntry(skill, { now: new Date("2026-01-02T03:04:05.000Z") });

    expect(refreshed.description).toBe("Refreshed from disk");
    expect(refreshed.status).toContain("valid");
    expect(refreshed.status).not.toContain("invalid");
    expect(refreshed.issues).toHaveLength(0);
    expect(refreshed.frontmatter).toMatchObject({ name: "stale-skill", description: "Refreshed from disk" });
    expect(refreshed.updatedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  it("throws UnsafeSourceError when profileRoot is missing and allowUnsafeSource=false", async () => {
    const skill = await setupInvalidSkill(cwd, "unsafe-skill");
    await expect(applyFrontmatterFix(skill, {})).rejects.toBeInstanceOf(UnsafeSourceError);
  });

  it("refuses to write outside profileRoot", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "lsh-fm-out-"));
    const skill = await setupInvalidSkill(cwd, "escape-skill");
    await expect(applyFrontmatterFix(skill, { profileRoot: outside, allowUnsafeSource: true })).rejects.toThrow(/escapes allowed root/);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("finds invalid skills in a manifest", async () => {
    const skill = await setupInvalidSkill(cwd, "marker-skill");
    const manifest: RegistryManifest = {
      version: 2,
      generatedAt: new Date().toISOString(),
      skills: [skill]
    };
    const invalid = findInvalidSkills(manifest);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.id).toBe(skill.id);
  });
});

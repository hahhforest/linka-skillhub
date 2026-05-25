import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkillSources, importSkillsToRepository, scanSkills, validateRegistryPath, writeRegistryManifest } from "../src/index.js";
import type { RegistryManifest } from "../src/types.js";

const writeSkill = async (dir: string, name: string, description: string): Promise<void> => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`, "utf8");
};

describe("scanner and registry", () => {
  it("scans project OpenCode skills and imports original packages", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "linka-skillhub-"));
    const skillDir = path.join(cwd, ".opencode", "skills", "sample-skill");
    await writeSkill(skillDir, "sample-skill", "Use when testing scanner.");

    const sources = await discoverSkillSources(cwd);
    const selected = sources.filter((source) => source.rootPath.includes(`${path.sep}.opencode${path.sep}skills`)).map((source) => source.id);
    const skills = await scanSkills({ cwd, selectedSourceIds: selected });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.status).toContain("valid");
    expect(skills[0]?.status).toContain("portable");

    const repoPath = path.join(cwd, "registry-repo");
    const result = await importSkillsToRepository({ repoPath, cwd, selectedSourceIds: selected });
    expect(result.imported).toBe(1);
    expect(await fs.stat(path.join(repoPath, "registry", "skills.json"))).toBeTruthy();
    expect(await fs.stat(path.join(repoPath, "skills", "sample-skill", skills[0]!.variantId, "SKILL.md"))).toBeTruthy();
  });
});

describe("validateRegistryPath", () => {
  it("accepts a real registry manifest inside the profile root", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "linka-skillhub-validate-"));
    const repoPath = path.join(cwd, "registry");
    const manifest: RegistryManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      skills: []
    };
    await writeRegistryManifest(repoPath, manifest);
    const result = await validateRegistryPath(repoPath, { cwd, profileRoot: cwd });
    expect(result.ok).toBe(true);
    expect(result.skillCount).toBe(0);
    expect(result.manifestVersion).toBe(1);
  });

  it("rejects paths that escape the profile root", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "linka-skillhub-validate-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "linka-skillhub-outside-"));
    const repoPath = path.join(outside, "registry");
    await writeRegistryManifest(repoPath, { version: 1, generatedAt: new Date().toISOString(), skills: [] });
    const result = await validateRegistryPath(repoPath, { cwd, profileRoot: cwd });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("outside_profile_root");
  });

  it("returns missing_manifest when registry/skills.json does not exist", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "linka-skillhub-validate-"));
    const result = await validateRegistryPath(path.join(cwd, "no-such-registry"), { cwd, profileRoot: cwd });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_manifest");
  });

  it("returns invalid_manifest when skills.json is not a valid manifest", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "linka-skillhub-validate-"));
    const repoPath = path.join(cwd, "registry");
    await fs.mkdir(path.join(repoPath, "registry"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "registry", "skills.json"), "{not json", "utf8");
    const result = await validateRegistryPath(repoPath, { cwd, profileRoot: cwd });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_manifest");
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkillSources, importSkillsToRepository, scanSkills } from "../src/index.js";

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
